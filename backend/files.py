import json
import mimetypes
import shutil
import threading

from backend.schemas import ApiError, dump, identifier, uid


def atomic_write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_bytes(data)
    temporary.replace(path)


class Files:
    def __init__(self, directory):
        self.directory = directory / 'projects'
        self.directory.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()

    def project(self, project_id):
        return self.directory / identifier(project_id)

    def manifest(self, project_id):
        path = self.project(project_id) / 'manifest.json'
        return json.loads(path.read_text()) if path.exists() else {}

    def save(self, project_id, relative, data, mime=None):
        with self.lock:
            folder = self.project(project_id)
            path = folder / relative
            if not path.resolve().is_relative_to(folder.resolve()):
                raise ApiError(400, '文件路径无效')
            atomic_write(path, data)
            file_id = uid()
            manifest = self.manifest(project_id)
            manifest[file_id] = {'path': relative, 'mime': mime or mimetypes.guess_type(relative)[0] or 'application/octet-stream'}
            atomic_write(folder / 'manifest.json', dump(manifest).encode())
            return file_id

    def find(self, file_id):
        identifier(file_id)
        with self.lock:
            for path in self.directory.glob('*/manifest.json'):
                entry = json.loads(path.read_text()).get(file_id)
                if entry is None:
                    continue
                target = (path.parent / entry['path']).resolve()
                if not target.is_relative_to(path.parent.resolve()) or not target.is_file():
                    raise ApiError(404, '文件不存在', 'NOT_FOUND')
                return target, entry['mime']
        raise ApiError(404, '文件不存在', 'NOT_FOUND')

    def copy(self, project_id, file_id, relative):
        path, mime = self.find(file_id)
        return self.save(project_id, relative, path.read_bytes(), mime)

    def remove_folder(self, project_id, relative):
        with self.lock:
            folder = self.project(project_id)
            target = (folder / relative).resolve()
            if not target.is_relative_to(folder.resolve()):
                raise ApiError(400, '文件路径无效')
            manifest = self.manifest(project_id)
            manifest = {key: value for key, value in manifest.items()
                        if not (folder / value['path']).resolve().is_relative_to(target)}
            atomic_write(folder / 'manifest.json', dump(manifest).encode())
            shutil.rmtree(target, ignore_errors=True)

    def remove_project(self, project_id):
        with self.lock:
            shutil.rmtree(self.project(project_id), ignore_errors=True)

    def cleanup(self, database):
        projects = {row['id'] for row in database.rows('SELECT id FROM projects')}
        for directory in self.directory.iterdir():
            if not directory.is_dir() or directory.is_symlink():
                continue
            if directory.name not in projects:
                shutil.rmtree(directory)
                continue
            referenced = set()
            for row in database.rows('SELECT file_ref,page_file_ids_json FROM quotes WHERE project_id=?', (directory.name,)):
                referenced.add(row['file_ref'])
                referenced.update(json.loads(row['page_file_ids_json']))
            for row in database.rows('SELECT snapshot_json FROM comparisons WHERE project_id=?', (directory.name,)):
                for source in json.loads(row['snapshot_json'])['sources']:
                    referenced.add(source['original_file_id'])
                    referenced.update(source['page_file_ids'])
            for row in database.rows("SELECT result_json FROM jobs WHERE project_id=? AND state='succeeded' AND kind='report'", (directory.name,)):
                result = json.loads(row['result_json'] or '{}')
                referenced.update(result[key] for key in ('preview_file_id', 'report_file_id') if key in result)
            manifest = self.manifest(directory.name)
            keep = {key: entry for key, entry in manifest.items() if key in referenced}
            paths = {(directory / entry['path']).resolve() for entry in keep.values()}
            for path in directory.rglob('*'):
                if path.is_file() and path.name != 'manifest.json' and path.resolve().is_relative_to(directory.resolve()) and path.resolve() not in paths:
                    path.unlink()
            atomic_write(directory / 'manifest.json', dump(keep).encode())
