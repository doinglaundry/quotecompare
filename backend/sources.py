import io
import sys

from PIL import Image, ImageOps
from pypdf import PdfReader
import pypdfium2 as pdfium

from backend.schemas import ApiError, uid, validate


def ocr(path, page):
    if sys.platform != 'darwin':
        raise ApiError(422, '扫描文件需要 macOS Vision OCR', 'OCR_UNAVAILABLE')
    import Vision
    import Foundation
    import objc
    with objc.autorelease_pool():
        request = Vision.VNRecognizeTextRequest.alloc().init()
        request.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
        request.setRecognitionLanguages_(['en-US', 'zh-Hans'])
        handler = Vision.VNImageRequestHandler.alloc().initWithURL_options_(Foundation.NSURL.fileURLWithPath_(str(path)), {})
        succeeded, error = handler.performRequests_error_([request], None)
        if not succeeded:
            raise ApiError(422, '图片文字识别失败，请换清晰文件', 'OCR_FAILED')
        blocks = []
        for observation in request.results() or []:
            candidate = observation.topCandidates_(1)[0]
            bounds = observation.boundingBox()
            box = [float(bounds.origin.x), float(1 - bounds.origin.y - bounds.size.height),
                   float(bounds.size.width), float(bounds.size.height)]
            block = {'id': uid(), 'page': page, 'text': str(candidate.string()),
                     'bbox': [max(0, min(1, value)) for value in box], 'ocr_confidence': float(candidate.confidence())}
            blocks.append(validate('SourceBlock', block))
        return blocks


def read_source(files, project_id, quote_id, original_id, source_type):
    original, mime = files.find(original_id)
    blocks, pages = [], []
    try:
        if source_type == 'image':
            with Image.open(original) as image:
                if image.width * image.height > 40_000_000:
                    raise ApiError(413, '图片分辨率过大', 'LIMIT_EXCEEDED')
                image.load()
                image = ImageOps.exif_transpose(image).convert('RGB')
                buffer = io.BytesIO()
                image.save(buffer, 'PNG')
            page_id = files.save(project_id, f'quotes/{quote_id}/pages/1.png', buffer.getvalue(), 'image/png')
            pages.append(page_id)
            path, mime = files.find(page_id)
            blocks = ocr(path, 1)
            method = 'vision_ocr'
        else:
            reader = PdfReader(original)
            if reader.is_encrypted:
                raise ApiError(422, '请先解密 PDF 再导入', 'ENCRYPTED_PDF')
            if not 1 <= len(reader.pages) <= 30:
                raise ApiError(413, 'PDF 最多 30 页', 'LIMIT_EXCEEDED')
            document = pdfium.PdfDocument(original)
            scanned = 0
            try:
                for number, pdf_page in enumerate(reader.pages, 1):
                    page = document[number - 1]
                    width, height = page.get_size()
                    if width <= 0 or height <= 0:
                        page.close()
                        raise ApiError(422, 'PDF 页面尺寸不正确', 'INVALID_DOCUMENT')
                    bitmap = page.render(scale=min(1.5, 5000 / max(width, height)))
                    try:
                        image = bitmap.to_pil()
                        buffer = io.BytesIO()
                        image.save(buffer, 'PNG')
                    finally:
                        bitmap.close()
                        page.close()
                    page_id = files.save(project_id, f'quotes/{quote_id}/pages/{number}.png', buffer.getvalue(), 'image/png')
                    pages.append(page_id)
                    text = (pdf_page.extract_text() or '').strip()
                    if text:
                        blocks.append({'id': uid(), 'page': number, 'text': text, 'bbox': None, 'ocr_confidence': None})
                    else:
                        scanned += 1
                        path, mime = files.find(page_id)
                        blocks.extend(ocr(path, number))
            finally:
                document.close()
            method = 'pdf_text' if scanned == 0 else 'vision_ocr' if scanned == len(pages) else 'mixed'
        if not blocks:
            raise ApiError(422, '文件中未识别到文字，请换清晰文件', 'NO_TEXT')
        return blocks, pages, method
    except ApiError:
        raise
    except Exception:
        raise ApiError(422, '无法读取文件，请检查格式或文件是否损坏', 'INVALID_DOCUMENT') from None
