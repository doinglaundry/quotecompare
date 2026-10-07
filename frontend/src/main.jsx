import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const { api } = window.desktop;
const newId = () => crypto.randomUUID().replaceAll('-', '');
const providerNames = { openai: 'OpenAI', claude: 'Claude', deepseek: 'DeepSeek' };
const jobStateLabels = { queued: '等待处理', running: '处理中', succeeded: '已完成', partial_failed: '部分失败', failed: '失败', cancel_requested: '正在取消', cancelled: '已取消', interrupted: '上次退出时中断' };
const callPurposeLabels = { extraction: '报价提取', alignment: '字段归并', draft: '邮件草稿', connection_test: '连接测试' };
const activeStates = ['queued', 'running', 'cancel_requested'];
const fieldKindLabels = { project_total: '总价', line_total: '分项金额', unit_price: '单价', quantity: '数量', material: '材料', scope: '施工范围', term: '条款', tax: '税费', other: '其他' };
const taxLabels = { included: '含税', excluded: '未含税', unknown: '未注明', not_applicable: '不适用' };
const coverageLabels = { separate: '独立项目', bundled: '打包包含', unknown: '未注明', not_applicable: '不适用' };

async function fetchPages(operation, args = {}, field = 'items') {
  const items = [];
  let page;
  do {
    page = await api(operation, { ...args, query: { ...args.query, limit: 100, ...(page?.next_cursor ? { cursor: page.next_cursor } : {}) } });
    items.push(...page[field]);
  } while (page.next_cursor);
  return { ...page, [field]: items };
}

function useFileUrl(fileId, onError) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    let cancelled = false;
    let objectUrl;
    setUrl('');
    if (fileId) api('file', { id: fileId }).then((file) => {
      objectUrl = URL.createObjectURL(new Blob([file.data], { type: file.type }));
      if (!cancelled) setUrl(objectUrl); else URL.revokeObjectURL(objectUrl);
    }).catch((error) => { if (!cancelled) onError?.(error.message); });
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [fileId, onError]);
  return url;
}

function FileImage({ fileId, boxes = [] }) {
  const url = useFileUrl(fileId);
  return <div className="source-image">{url ? <img src={url} alt="报价原文页面" /> : <p>加载原文…</p>}{boxes.map((box, index) => <div key={index} className="highlight" style={{ left: box[0] * 100 + '%', top: box[1] * 100 + '%', width: box[2] * 100 + '%', height: box[3] * 100 + '%' }} />)}</div>;
}

function App() {
  const [view, setView] = useState('materials');
  const [projects, setProjects] = useState([]);
  const [project, setProject] = useState(null);
  const [quote, setQuote] = useState(null);
  const [selectedFact, setSelectedFact] = useState(null);
  const [fieldGroups, setFieldGroups] = useState([]);
  const [history, setHistory] = useState([]);
  const [comparison, setComparison] = useState(null);
  const [filter, setFilter] = useState('all');
  const [draft, setDraft] = useState(null);
  const [selectedQuoteId, setSelectedQuoteId] = useState('');
  const [selectedQuestionIds, setSelectedQuestionIds] = useState([]);
  const [language, setLanguage] = useState('en');
  const [settings, setSettings] = useState(null);
  const [provider, setProvider] = useState('openai');
  const [apiKey, setApiKey] = useState('');
  const [usage, setUsage] = useState(null);
  const [balance, setBalance] = useState(null);
  const [usageProvider, setUsageProvider] = useState('');
  const [generation, setGeneration] = useState('');
  const [usageFrom, setUsageFrom] = useState('');
  const [usageTo, setUsageTo] = useState('');
  const [job, setJob] = useState(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [modal, setModal] = useState(null);
  const [projectForm, setProjectForm] = useState({ name: '', property: '', scope: '', currency: 'GBP' });
  const [paste, setPaste] = useState('');
  const [importContractorName, setImportContractorName] = useState('');
  const [reportOptions, setReportOptions] = useState({ format: 'pdf', include_sources: true, include_questions: true, hide_property: false });
  const [report, setReport] = useState(null);
  const preview = useFileUrl(report?.preview_file_id, setError);

  async function loadProjects(selectedId) {
    const { items: all } = await fetchPages('projects');
    setProjects(all);
    const selected = all.find((item) => item.id === (selectedId || project?.id))?.id || all[0]?.id;
    if (selected) await loadProject(selected);
    else { setProject(null); setQuote(null); setComparison(null); setHistory([]); }
  }
  async function loadProject(projectId) {
    const data = await api('project', { id: projectId });
    setProject(data);
    const { items: snapshots } = await fetchPages('comparisons', { id: projectId });
    snapshots.sort((a, b) => b.created_at.localeCompare(a.created_at));
    setHistory(snapshots);
    if (snapshots.length) await loadComparison(snapshots[0].id);
    else { setComparison(null); setDraft(null); }
    setFieldGroups(data.field_groups);
    if (data.quotes.length) setQuote(await api('quote', { id: data.quotes[0].id }));
    else setQuote(null);
  }
  async function loadComparison(comparisonId) {
    const data = await api('comparison', { id: comparisonId });
    setComparison(data); setReport(null);
    await selectDraftQuote(data, data.comparison.columns[0]?.quote_id || '');
  }
  async function selectDraftQuote(snapshot, quoteId) {
    setSelectedQuoteId(quoteId); setDraft(null);
    setSelectedQuestionIds(snapshot.questions.filter((item) => item.quote_id === quoteId && item.selected_by_default).map((item) => item.id));
    const storageKey = 'draft:' + snapshot.comparison.id + ':' + quoteId;
    const stored = localStorage.getItem(storageKey);
    if (stored) {
      try { const value = await api('draft', { id: stored }); if (value.comparison_id === snapshot.comparison.id && value.quote_id === quoteId) setDraft(value); }
      catch { localStorage.removeItem(storageKey); }
    }
  }
  async function refreshSettings() {
    const value = await api('settings');
    setSettings(value); setProvider(value.provider); setApiKey('');
  }
  async function refreshUsage() {
    const query = { ...(usageFrom ? { from: new Date(usageFrom + 'T00:00:00').toISOString() } : {}), ...(usageTo ? { to: new Date(usageTo + 'T23:59:59.999').toISOString() } : {}), ...(usageProvider ? { provider: usageProvider } : {}), ...(generation ? { connection_generation: generation } : {}) };
    setUsage(await fetchPages('usage', { query }, 'calls'));
    setBalance(await api('balance'));
  }
  async function runAction(action) {
    setPending(true); setError(''); setNotice('');
    try { await action(); } catch (failure) { setError(failure.message.replace(/^Error invoking remote method '[^']*': Error: /, '')); }
    finally { setPending(false); }
  }
  async function startJob(body) {
    const created = await api('createJob', { body: { request_id: newId(), ...body } });
    setJob(created); localStorage.setItem('active-job', created.id);
  }
  useEffect(() => { runAction(async () => {
    await loadProjects(); await refreshSettings();
    const savedJob = localStorage.getItem('active-job');
    if (savedJob) { try { setJob(await api('job', { id: savedJob })); } catch { localStorage.removeItem('active-job'); } }
  }); }, []);
  useEffect(() => {
    if (!job || !activeStates.includes(job.state)) return;
    let polling = false;
    const timer = setInterval(async () => {
      if (polling) return;
      polling = true;
      let next;
      try {
        next = await api('job', { id: job.id });
        if (!activeStates.includes(next.state)) {
          clearInterval(timer);
          localStorage.removeItem('active-job');
          if (next.error) setError(next.error.message);
          if (next.result?.message) setNotice(next.result.message);
          if (['extraction', 'alignment'].includes(next.kind) && next.project_id === project?.id) await loadProject(next.project_id);
          if (next.result?.draft_ids?.length) { const value = await api('draft', { id: next.result.draft_ids[0] }); localStorage.setItem('draft:' + value.comparison_id + ':' + value.quote_id, value.id); if (value.project_id === project?.id) { setDraft(value); setSelectedQuoteId(value.quote_id); } }
          if (next.result?.report_file_id && next.project_id === project?.id) setReport(next.result);
          if (view === 'usage') await refreshUsage();
        }
      } catch (failure) { setError(failure.message); }
      finally { if (next) setJob(next); polling = false; }
    }, 750);
    return () => clearInterval(timer);
  }, [job?.id, job?.state, project?.id]);

  const busy = pending || job && activeStates.includes(job.state);
  const tabs = [['materials', '报价资料'], ['review', '核对'], ['comparison', '对比'], ['questions', '追问']];
  const selectedBlocks = quote?.source_blocks.filter((block) => selectedFact?.source_refs.some((ref) => ref.block_id === block.id)) || [];
  const sourcePage = selectedBlocks[0]?.page || 1;
  const showPage = (page) => { setView(page); setError(''); setNotice(''); if (page === 'usage') runAction(refreshUsage); if (page === 'settings' && settings) { setProvider(settings.provider); setApiKey(''); } };
  const reviseFact = (index, property, value) => setQuote({ ...quote, facts: quote.facts.map((fact, number) => number === index ? { ...fact, [property]: value } : fact) });
  async function importFiles(files) {
    let current = project;
    if (!current) throw new Error('请先创建项目');
    if (files.length + current.quotes.length > 5) throw new Error('每个项目最多五份报价');
    for (const file of files) {
      const detail = await api('importQuote', { id: current.id, body: { request_id: newId(), expected_revision: current.revision, source_type: file.name.toLowerCase().endsWith('.pdf') ? 'pdf' : 'image', ...(importContractorName ? { contractor_name: importContractorName } : {}) }, file });
      current = await api('project', { id: current.id }); setProject(current); setQuote(detail);
    }
    await loadProject(current.id); setModal(null); setImportContractorName(''); setNotice('报价已导入，点击 AI 提取开始核对。');
  }
  async function saveFacts() {
    setQuote(await api('updateQuote', { id: quote.id, body: { expected_revision: project.revision, contractor_name: quote.contractor_name, facts: quote.facts } }));
    const current = await api('project', { id: project.id });
    setProject(current);
    setFieldGroups(current.field_groups);
    setNotice('核对结果已保存；报价发生变化后需重新保存字段归并。');
  }
  async function saveMappings() {
    const saved = await api('saveMappings', { id: project.id, body: { expected_revision: project.revision, groups: fieldGroups } });
    setFieldGroups(saved.groups); setProject(await api('project', { id: project.id })); setNotice('统一字段已保存。');
  }
  function splitGroup(index) {
    const groups = fieldGroups.flatMap((item, number) => number === index ? item.members.map((member) => ({ ...item, id: newId(), members: [member], status: 'pending', reason: '用户拆分，等待确认' })) : [item]);
    setFieldGroups(groups.map((item, number) => ({ ...item, display_order: number })));
  }
  function mergeGroup(index, targetId) {
    const source = fieldGroups[index]; const target = fieldGroups.find((item) => item.id === targetId);
    if (!target) return;
    const keys = Object.keys(source.signature);
    if (keys.some((key) => source.signature[key] !== target.signature[key])) { setError('只有工项、单位、币种、税费和价格层级一致的字段才能归并。请先在核对页确认口径。'); return; }
    setFieldGroups(fieldGroups.filter((item) => item.id !== source.id).map((item) => item.id === target.id ? { ...item, members: [...item.members, ...source.members], status: 'pending', reason: '用户归并，等待确认' } : item));
  }

  const errorBanner = error && <div role="alert" className="banner error"><strong>操作未完成</strong> {error}<button onClick={() => setError('')}>×</button></div>;

  return <div className="shell">
    <aside className="app-sidebar"><div className="brand"><span>⌂</span><strong>Property Tools</strong></div><small>本地工作空间</small>
      <button className={tabs.some(([value]) => value === view) || view === 'report' ? 'nav active' : 'nav'} onClick={() => showPage('materials')}><span aria-hidden="true">▤</span> Quote Compare</button>
      <div className="sidebar-bottom"><p>更多功能将在这里加入</p><button className={'nav ' + (view === 'settings' ? 'active' : '')} onClick={() => showPage('settings')}>⚙ 模型设置</button><button className={'nav ' + (view === 'usage' ? 'active' : '')} onClick={() => showPage('usage')}>◷ 用量与费用</button><small>资料保存在此 Mac · v0.1</small></div>
    </aside>
    <main><header className="topbar">{tabs.map(([value, label]) => <button key={value} className={view === value ? 'tab selected' : 'tab'} onClick={() => showPage(value)}>{label}</button>)}<span className="local-badge">● Mac 本地</span></header>
      <div className="workspace">
        {!modal && errorBanner}
        {notice && <div role="status" className="banner success">{notice}</div>}
        {job && <div className="job" data-state={job.state}><span>{job.stage || '任务已提交'} · {job.completed_units}/{job.total_units} · {jobStateLabels[job.state]}</span>{activeStates.includes(job.state) && <><progress value={job.completed_units} max={job.total_units || 1}/><button onClick={() => runAction(async () => setJob(await api('cancelJob', { id: job.id })))}>取消任务</button></>}</div>}
        {['materials', 'review', 'comparison', 'questions', 'report'].includes(view) && <div className="project-toolbar"><select aria-label="当前项目" disabled={busy} value={project?.id || ''} onChange={(event) => runAction(() => loadProject(event.target.value))}><option value="" disabled>选择项目</option>{projects.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.status === 'active' ? '进行中' : item.status === 'completed' ? '已完成' : '已归档'}</option>)}</select><div><button disabled={!project || busy} onClick={() => { setModal({ type: 'import' }); setPaste(''); }}>＋ 导入报价</button><button disabled={!comparison} onClick={() => showPage('report')}>导出报告 ↗</button></div></div>}

        {view === 'materials' && <><div className="page-heading"><div><h1>项目与报价资料</h1><p>把同一项目的报价放在一起，保留完整原文。</p></div><button className="primary" disabled={busy} onClick={() => { setProjectForm({ name: '', property: '', scope: '', currency: 'GBP' }); setModal({ type: 'create' }); }}>＋ 新建项目</button></div>
          {!project ? <div className="empty"><h2>开始第一次报价比较</h2><p>先创建一个维修项目，再导入 2–5 份报价。</p></div> : <>
            <section className="card project-info"><div><h2>{project.name}</h2><p>{project.property || '尚未填写房产'} · {project.currency}</p><p>{project.scope || '尚未填写施工需求'}</p></div><div className="button-stack"><button disabled={busy} onClick={() => { setProjectForm({ name: project.name, property: project.property || '', scope: project.scope, currency: project.currency }); setModal({ type: 'edit' }); }}>编辑项目</button><select aria-label="项目状态" value={project.status} disabled={busy} onChange={(event) => runAction(async () => { await api('updateProject', { id: project.id, body: { expected_revision: project.revision, status: event.target.value } }); await loadProjects(project.id); })}><option value="active">进行中</option><option value="completed">已完成</option><option value="archived">已归档</option></select><button className="danger" disabled={busy} onClick={() => setModal({ type: 'deleteProject' })}>删除项目</button></div></section>
            <div className="section-heading"><h2>报价资料 <span>{project.quotes.length}/5</span></h2><button className="primary" disabled={busy || !project.quotes.length} onClick={() => runAction(async () => {
              const reviewed = project.quotes.some((item) => item.status === 'reviewed');
              if (reviewed) { setModal({ type: 'reextract' }); return; }
              await startJob({ kind: 'extraction', project_id: project.id, expected_revision: project.revision, quote_ids: project.quotes.map((item) => item.id) });
            })}>AI 提取全部报价</button></div>
            <div className="quote-grid">{project.quotes.map((item) => <article className="card quote-card" key={item.id}><div className="file-icon">{item.source_type.toUpperCase()}</div><h3>{item.contractor_name || item.filename || '未命名报价'}</h3><p>{item.filename || '粘贴的文字'}{item.page_count ? ' · ' + item.page_count + ' 页' : ''}</p><span className={'pill ' + (item.status === 'reviewed' ? 'green' : '')}>{({ imported: '已导入', extracting: '正在提取', review_required: '等待核对', reviewed: '已核对', failed: '提取失败' })[item.status]}</span><div className="card-actions"><button onClick={() => runAction(async () => { setQuote(await api('quote', { id: item.id })); setSelectedFact(null); showPage('review'); })}>打开核对</button><button className="danger" disabled={busy} onClick={() => setModal({ type: 'deleteQuote', quoteId: item.id })}>删除</button></div></article>)}{project.quotes.length < 5 && <button className="drop-card" disabled={busy} onClick={() => setModal({ type: 'import' })}><span>＋</span><strong>导入报价</strong><small>PDF / 图片 / 粘贴文字<br/>每份最大 50MB，PDF 最多 30 页</small></button>}</div>
            <section className="card"><h2>项目历史</h2><p>每次确认对比都会保存独立快照。之后修改或删除当前报价，历史内容仍保留。</p>{history.length ? history.map((item) => <button className="history-row" disabled={busy} key={item.id} onClick={() => runAction(async () => { await loadComparison(item.id); showPage('comparison'); })}><span>{new Date(item.created_at).toLocaleString()} · {item.columns.length} 份报价</span><span>{item.is_stale ? '历史快照' : '当前对比'} →</span></button>) : <p className="muted">完成核对和字段归并后，可保存第一份对比。</p>}</section>
          </>}</>}

        {view === 'review' && <><div className="page-heading"><div><h1>核对提取结果</h1><p>左边看原文，右边修改规范值。未注明的内容保持未知。</p></div><div className="actions"><button disabled={!quote || busy} onClick={() => { if (quote?.status === 'reviewed' || quote?.facts.some((fact) => fact.review_status === 'confirmed' || fact.origin === 'manual')) setModal({ type: 'reextractOne' }); else runAction(() => startJob({ kind: 'extraction', project_id: project.id, expected_revision: project.revision, quote_ids: [quote.id] })); }}>重新提取</button><button className="primary" disabled={!quote || busy} onClick={() => runAction(saveFacts)}>保存核对</button></div></div>
          <select className="quote-picker" aria-label="核对报价" disabled={busy} value={quote?.id || ''} onChange={(event) => runAction(async () => { setQuote(await api('quote', { id: event.target.value })); setSelectedFact(null); })}>{project?.quotes.map((item) => <option key={item.id} value={item.id}>{item.contractor_name || item.filename || item.id}</option>)}</select>
          {quote?.source_blocks ? <div className="review-layout"><section className="card source-panel"><div className="section-heading"><h2>报价原文</h2><button onClick={() => runAction(() => window.desktop.saveFile(quote.original_file_id, quote.filename || '报价原文.txt'))}>保存原件</button></div>{quote.page_file_ids.length > 0 && <FileImage fileId={quote.page_file_ids[sourcePage - 1]} boxes={selectedBlocks.filter((block) => block.page === sourcePage && block.bbox).map((block) => block.bbox)} />}
            <div className="source-blocks">{quote.source_blocks.map((block) => <button key={block.id} className={'source-text ' + (selectedBlocks.some((value) => value.id === block.id) ? 'focus' : '')} onClick={() => setSelectedFact(quote.facts.find((fact) => fact.source_refs.some((ref) => ref.block_id === block.id)) || null)}><small>{block.page ? '第 ' + block.page + ' 页' : '粘贴文字'}</small><pre>{block.text}</pre></button>)}</div></section>
            <section className="card fields-panel" data-quote-id={quote.id}><fieldset disabled={busy}><label>承包商名称<input aria-label="承包商名称" value={quote.contractor_name || ''} onChange={(event) => setQuote({ ...quote, contractor_name: event.target.value || null })}/></label><div className="section-heading"><h2>提取字段 · {quote.facts.length}</h2><button onClick={() => setQuote({ ...quote, facts: quote.facts.map((fact) => ({ ...fact, review_status: 'confirmed' })) })}>全部确认</button></div>{quote.warnings.map((warning, index) => <p className="warning" key={index}>{warning}</p>)}
              {!quote.facts.length && <p className="muted">先点击 AI 提取，或手动新增字段。</p>}
              {quote.facts.map((fact, index) => <div key={fact.id} className={'field-card ' + (selectedFact?.id === fact.id ? 'focus' : '')} onClick={() => setSelectedFact(fact)}><div className="section-heading">{fact.origin === 'manual' ? <input aria-label={'人工字段名称 ' + index} value={fact.raw_label} onChange={(event) => reviseFact(index, 'raw_label', event.target.value)}/> : <strong>{fact.raw_label}</strong>}<small>原文：{fact.raw_value ?? '未注明'}</small></div><div className="form-grid"><label>规范值<input aria-label={'规范值 ' + index} value={fact.normalized_value ?? ''} placeholder="未知留空" onChange={(event) => reviseFact(index, 'normalized_value', event.target.value || null)}/></label><label>字段含义<select aria-label={'字段含义 ' + index} value={fact.semantic_kind} onChange={(event) => reviseFact(index, 'semantic_kind', event.target.value)}>{Object.entries(fieldKindLabels).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label><label>值类型<select value={fact.value_type} onChange={(event) => reviseFact(index, 'value_type', event.target.value)}>{['text', 'decimal', 'boolean', 'date', 'duration'].map((type) => <option key={type}>{type}</option>)}</select></label><label>施工工项<input value={fact.entity_key || ''} placeholder="例如 kitchen_cabinets" onChange={(event) => reviseFact(index, 'entity_key', event.target.value || null)}/></label><label>单位<input value={fact.unit || ''} placeholder="例如 m² / day" onChange={(event) => reviseFact(index, 'unit', event.target.value || null)}/></label><label>币种<input value={fact.currency || ''} maxLength={3} onChange={(event) => reviseFact(index, 'currency', event.target.value.toUpperCase() || null)}/></label><label>税费<select value={fact.tax_basis} onChange={(event) => reviseFact(index, 'tax_basis', event.target.value)}>{Object.entries(taxLabels).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label><label>包含口径<select value={fact.coverage} onChange={(event) => reviseFact(index, 'coverage', event.target.value)}>{Object.entries(coverageLabels).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label></div><div className="card-actions"><select aria-label={'核对状态 ' + index} value={fact.review_status} onChange={(event) => reviseFact(index, 'review_status', event.target.value)}><option value="unreviewed">未核对</option><option value="pending">待确认</option><option value="confirmed">已确认</option></select><button className="danger" onClick={() => setQuote({ ...quote, facts: quote.facts.filter((item) => item.id !== fact.id) })}>移除字段</button></div></div>)}
              <button onClick={() => setQuote({ ...quote, facts: [...quote.facts, { id: newId(), raw_label: '人工新增字段', raw_value: null, normalized_value: null, value_type: 'text', semantic_kind: 'other', entity_key: null, unit: null, currency: null, tax_basis: 'unknown', coverage: 'unknown', source_refs: [], origin: 'manual', review_status: 'pending' }] })}>＋ 新增字段</button>
            </fieldset></section></div> : <div className="empty">请先导入报价。</div>}
          <section className="card mapping-panel"><div className="section-heading"><div><h2>统一对比字段</h2><p>保留全部字段；含义和口径一致才归为同一项。</p></div><div className="actions"><button disabled={busy || !project} onClick={() => runAction(() => startJob({ kind: 'alignment', project_id: project.id, expected_revision: project.revision }))}>AI 汇总字段</button><button disabled={!fieldGroups.length || busy} onClick={() => setFieldGroups(fieldGroups.map((group) => ({ ...group, status: 'confirmed' })))}>全部确认归并</button><button className="primary" disabled={!fieldGroups.length || busy} onClick={() => runAction(saveMappings)}>保存统一字段</button></div></div>
            {project?.mappings_revision !== project?.revision && <p className="warning">报价或施工需求已变化，需重新核对并保存归并。</p>}
            {fieldGroups.map((group, index) => <div className="mapping-row" key={group.id}><input aria-label={'统一字段 ' + index} value={group.label} onChange={(event) => setFieldGroups(fieldGroups.map((value, number) => number === index ? { ...value, label: event.target.value } : value))}/><div><small>{fieldKindLabels[group.signature.semantic_kind]} · {group.signature.currency || '无币种'} · {taxLabels[group.signature.tax_basis]}</small><p>{group.reason}</p><small>{group.members.map((member) => (project?.quotes.find((item) => item.id === member.quote_id)?.contractor_name || member.quote_id) + ' / ' + member.fact_id).join('；')}</small></div><select value={group.status} onChange={(event) => setFieldGroups(fieldGroups.map((value, number) => number === index ? { ...value, status: event.target.value } : value))}><option value="suggested">AI 建议</option><option value="pending">待确认</option><option value="confirmed">已确认</option></select><button disabled={group.members.length < 2} onClick={() => splitGroup(index)}>拆分</button><select aria-label={'归并到 ' + index} value="" onChange={(event) => mergeGroup(index, event.target.value)}><option value="">归并到…</option>{fieldGroups.filter((item) => item.id !== group.id).map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></div>)}
          </section></>}

        {view === 'comparison' && <><div className="page-heading"><div><h1>完整报价对比</h1><p>每列一份报价，每行一个统一字段；没有提供的内容留空标明。</p></div><button className="primary" disabled={busy || !project} onClick={() => runAction(async () => {
            try { await api('createComparison', { id: project.id, body: { request_id: newId(), expected_revision: project.revision } }); await loadProject(project.id); }
            catch (failure) { if (failure.message.includes('待核对')) setModal({ type: 'allowPending' }); else throw failure; }
          })}>确认并保存对比</button></div>
          {comparison ? <><div className={'banner ' + (comparison.comparison.can_compare_final_total ? 'success' : 'warning')}><strong>{comparison.comparison.summary}</strong>{comparison.comparison.is_stale && <p>这是一份历史快照；当前报价已更新。重新确认可生成新对比。</p>}</div><div className="comparison-toolbar"><div className="segmented">{[['all', '全部字段'], ['differences', '只看差异'], ['missing', '缺失与待确认']].map(([value, text]) => <button key={value} className={filter === value ? 'selected' : ''} onClick={() => setFilter(value)}>{text}</button>)}</div><select aria-label="对比历史" disabled={busy} value={comparison.comparison.id} onChange={(event) => runAction(() => loadComparison(event.target.value))}>{history.map((item) => <option value={item.id} key={item.id}>{new Date(item.created_at).toLocaleString()}</option>)}</select></div>
            <div className="table-wrap"><table><thead><tr><th>统一字段 / 口径</th>{comparison.comparison.columns.map((column) => <th key={column.quote_id}>{column.contractor_name}<small>{column.currency || '币种未注明'}</small></th>)}</tr></thead><tbody>{comparison.comparison.rows.filter((row) => filter === 'all' || filter === 'differences' && row.has_difference || filter === 'missing' && row.cells.some((cell) => cell.state !== 'provided')).map((row) => <tr key={row.field_id}><th>{row.label}<small>{fieldKindLabels[row.signature.semantic_kind]} · {taxLabels[row.signature.tax_basis]} {row.signature.unit || ''}</small></th>{row.cells.map((cell) => <td key={cell.quote_id} className={cell.state}><button className="cell-value" onClick={() => setModal({ type: 'evidence', source: comparison.sources.find((source) => source.quote_id === cell.quote_id), refs: cell.source_refs })}>{cell.display_value}<small>{cell.state !== 'provided' ? cell.note : '查看原文依据 ↗'}</small></button></td>)}</tr>)}</tbody></table></div>
            <section className="card"><h2>缺失与风险提示 · {comparison.flags.length}</h2><div className="flags">{comparison.flags.map((flag) => <div key={flag.id}><span>!</span><p><strong>{comparison.comparison.columns.find((column) => column.quote_id === flag.quote_id)?.contractor_name || '整体提示'}</strong><br/>{flag.message}</p></div>)}</div><button onClick={() => showPage('questions')}>根据这些问题生成追问 →</button></section>
          </> : <div className="empty"><h2>还没有对比快照</h2><p>先核对报价、确认统一字段，再点击“确认并保存对比”。</p><button onClick={() => showPage('review')}>前往核对</button></div>}</>}

        {view === 'questions' && <><div className="page-heading"><div><h1>承包商追问</h1><p>把缺失信息变成具体问题，生成可修改、可复制的邮件草稿。</p></div></div>{comparison ? <div className="two-columns"><section className="card"><h2>选择承包商与问题</h2><select aria-label="追问承包商" disabled={busy} value={selectedQuoteId} onChange={(event) => runAction(() => selectDraftQuote(comparison, event.target.value))}>{comparison.comparison.columns.map((column) => <option value={column.quote_id} key={column.quote_id}>{column.contractor_name}</option>)}</select>{comparison.questions.filter((question) => question.quote_id === selectedQuoteId).map((question) => <label className="check-question" key={question.id}><input type="checkbox" checked={selectedQuestionIds.includes(question.id)} onChange={(event) => setSelectedQuestionIds(event.target.checked ? [...selectedQuestionIds, question.id] : selectedQuestionIds.filter((qid) => qid !== question.id))}/><span>{question.text}</span></label>)}<label>邮件语言<select aria-label="邮件语言" value={language} onChange={(event) => setLanguage(event.target.value)}><option value="en">English</option><option value="zh-CN">简体中文</option></select></label><button className="primary" disabled={busy || !selectedQuestionIds.length} onClick={() => runAction(() => startJob({ kind: 'draft', project_id: project.id, comparison_id: comparison.comparison.id, quote_id: selectedQuoteId, question_ids: selectedQuestionIds, language }))}>生成邮件草稿</button></section><section className="card"><div className="section-heading"><h2>邮件草稿</h2><span className="pill">审核后自行发送</span></div>{draft ? <><label>主题<input aria-label="邮件主题" value={draft.subject} onChange={(event) => setDraft({ ...draft, subject: event.target.value })}/></label><label>正文<textarea aria-label="邮件正文" className="email-body" value={draft.body} onChange={(event) => setDraft({ ...draft, body: event.target.value })}/></label><div className="actions"><button disabled={busy} onClick={() => runAction(async () => { setDraft(await api('saveDraft', { id: draft.id, body: { expected_revision: draft.revision, subject: draft.subject, body: draft.body } })); setNotice('草稿已保存。'); })}>保存草稿</button><button className="primary" onClick={() => runAction(async () => { await window.desktop.copy(draft.subject + '\n\n' + draft.body); setNotice('邮件已复制，请自行审核并发送。'); })}>复制邮件</button></div></> : <div className="empty">选择问题后生成草稿。</div>}</section></div> : <div className="empty">先保存一份对比快照。</div>}</>}

        {view === 'report' && <><div className="page-heading"><div><h1>报告预览与导出</h1><p>报告基于所选对比快照，不受后续报价修改影响。</p></div><button onClick={() => showPage('comparison')}>返回对比</button></div><div className="report-layout"><section className="card"><h2>导出选项</h2><label>文件格式<select aria-label="报告格式" disabled={busy} value={reportOptions.format} onChange={(event) => { setReport(null); setReportOptions({ ...reportOptions, format: event.target.value }); }}><option value="pdf">PDF 报告</option><option value="csv">CSV 表格</option></select></label>{[['include_sources', '附带原文依据（文字）'], ['include_questions', '附带追问清单'], ['hide_property', '隐藏房产名称 / 地址']].map(([value, text]) => <label className="checkbox" key={value}><input type="checkbox" disabled={busy} checked={reportOptions[value]} onChange={(event) => { setReport(null); setReportOptions({ ...reportOptions, [value]: event.target.checked }); }}/>{text}</label>)}<p className="muted">隐藏房产时，正文和原文文字附录都会处理；导出不附原始文件和图片。</p><button className="primary" disabled={busy || !comparison} onClick={() => runAction(() => startJob({ kind: 'report', project_id: project.id, comparison_id: comparison.comparison.id, report_options: reportOptions }))}>生成报告预览</button><button disabled={!report || busy} onClick={() => runAction(async () => { const saved = await window.desktop.saveFile(report.report_file_id, 'QuoteCompare-report.' + reportOptions.format); if (saved) setNotice('报告已保存。'); })}>保存文件到 Mac</button></section><section className="card report-preview">{preview ? <iframe title="报告预览" sandbox="" src={preview}/> : <div className="empty"><h2>完整报告预览</h2><p>选择选项，再点击“生成报告预览”。</p></div>}</section></div></>}

        {view === 'settings' && <><div className="page-heading"><div><h1>模型设置</h1><p>选择一家服务商，填写自己的 API Key。当前只保存一组配置。</p></div></div><div className="settings-layout"><section className="card"><h2>当前模型连接</h2><label>模型服务商<select aria-label="模型服务商" value={provider} disabled={busy} onChange={(event) => { setProvider(event.target.value); setApiKey(''); }}>{Object.entries(providerNames).map(([value, text]) => <option value={value} key={value}>{text}</option>)}</select></label><label>API Key<input aria-label="API Key" type="password" autoComplete="off" value={apiKey} placeholder={settings?.has_key && settings.provider === provider ? '已保存 · 末四位 ' + settings.key_hint + '（留空保留）' : '输入所选服务商的 API Key'} onChange={(event) => setApiKey(event.target.value)}/></label><p className="muted">密钥保存在 macOS 钥匙串。切换服务商会删除旧配置中的密钥，需填写新的 Key。</p><div className="actions"><button className="primary" disabled={busy} onClick={() => runAction(async () => { await api('saveSettings', { body: { expected_revision: settings.revision, provider, ...(apiKey ? { api_key: apiKey } : {}) } }); await refreshSettings(); setNotice('模型设置已保存。'); })}>保存设置</button><button disabled={busy || !settings?.has_key || provider !== settings.provider} onClick={() => runAction(() => startJob({ kind: 'connection_test', expected_connection_revision: settings.revision }))}>测试连接</button><button disabled={busy || !settings?.has_key} onClick={() => runAction(async () => { await api('saveSettings', { body: { expected_revision: settings.revision, provider: settings.provider, api_key: null } }); await refreshSettings(); })}>删除密钥</button></div><p className="muted">连接测试和 AI 分析会调用所选服务商并产生费用。报价原文将发送到该服务商处理。</p></section><section className="card"><h2>预设模型与计费</h2><p>当前保存：{providerNames[settings?.provider]} · {settings?.model_id}</p><span className="pill">价格状态：{({ known: '已核对', unknown: '无法确认', stale: '需重新核对' })[settings?.pricing.status]}</span>{settings?.pricing.tiers.map((tier) => <div className="price-tier" key={tier.name}><h3>{tier.name}</h3><p>每百万输入 {tier.input_per_million} {tier.currency}<br/>每百万缓存输入 {tier.cached_input_per_million ?? '未知'} {tier.currency}<br/>每百万输出 {tier.output_per_million} {tier.currency}</p><small>{tier.conditions}</small></div>)}<p className="muted">费用为本应用估算，价格过期、条件不明或 Token 未知时不计算；实际费用以服务商账单为准。</p><button onClick={() => showPage('usage')}>查看用量与费用 →</button></section></div></>}

        {view === 'usage' && <><div className="page-heading"><div><h1>用量与费用</h1><p>本应用调用记录与服务商账户余额分别展示。</p></div><button disabled={pending} onClick={() => runAction(refreshUsage)}>刷新用量</button></div><div className="actions filters"><input aria-label="用量开始日期" type="date" value={usageFrom} onChange={(event) => setUsageFrom(event.target.value)}/><input aria-label="用量结束日期" type="date" value={usageTo} onChange={(event) => setUsageTo(event.target.value)}/><select aria-label="用量服务商" value={usageProvider} onChange={(event) => setUsageProvider(event.target.value)}><option value="">全部服务商</option>{Object.entries(providerNames).map(([value, text]) => <option value={value} key={value}>{text}</option>)}</select><input aria-label="配置代际" type="number" min="1" value={generation} onChange={(event) => setGeneration(event.target.value)} placeholder="配置代际（选填）"/><button onClick={() => runAction(refreshUsage)}>应用筛选</button></div><div className="metrics"><section className="card"><small>本应用调用次数</small><strong>{usage?.summary.call_count ?? '—'}</strong></section><section className="card"><small>已知输入 / 输出 Token</small><strong>{usage?.summary.input_tokens_known ?? '—'} / {usage?.summary.output_tokens_known ?? '—'}</strong></section><section className="card"><small>可估算费用（各币种分开）</small><strong>{usage?.summary.costs.map((cost) => cost.known_estimated_amount + ' ' + cost.currency).join('；') || '暂无可估算费用'}</strong><small>{usage?.calls.filter((call) => !call.estimated_cost).length ?? 0} 次调用费用未知</small></section></div><section className="card balance-card"><div><h2>{providerNames[balance?.provider]} 官方账户余额</h2><p>{balance?.balances.map((value) => value.total + ' ' + value.currency).join('；') || balance?.reason || '加载中'}</p><small>{({ available: '已查询', unsupported: '请查看官方账单', not_configured: '尚未配置', unavailable: '查询失败', stale: '上次余额' })[balance?.status]} {balance?.checked_at ? ' · 查询时间 ' + new Date(balance.checked_at).toLocaleString() : ''}</small></div><div className="actions"><button onClick={() => runAction(async () => setBalance(await api('balance', { query: { refresh: true } })))}>查询最新余额</button><button onClick={() => runAction(() => window.desktop.billing(balance?.provider || provider))}>打开官方账单 ↗</button></div></section><div className="table-wrap"><table><thead><tr><th>调用时间</th><th>服务商 / 模型</th><th>用途 / 结果</th><th>配置代际</th><th>输入 / 输出 Token</th><th>预计费用</th></tr></thead><tbody>{usage?.calls.map((call) => <tr key={call.id}><td>{new Date(call.created_at).toLocaleString()}</td><td>{providerNames[call.provider]}<small>{call.model_id}</small></td><td>{callPurposeLabels[call.purpose]}<small>{({ succeeded: '成功', failed: '失败', cancelled: '已取消', unknown: '结果未知' })[call.outcome]}</small></td><td>{call.connection_generation}</td><td>{call.input_tokens ?? '未知'} / {call.output_tokens ?? '未知'}</td><td>{call.estimated_cost ? call.estimated_cost.amount + ' ' + call.estimated_cost.currency : '无法估算'}</td></tr>)}</tbody></table></div></>}
      </div>
    </main>

    {modal && <div className="modal-backdrop"><section role="dialog" aria-modal="true" className="modal"><button className="close" onClick={() => setModal(null)}>×</button>{errorBanner}
      {['create', 'edit'].includes(modal.type) && <form onSubmit={(event) => { event.preventDefault(); runAction(async () => {
        if (modal.type === 'create') { const value = await api('createProject', { body: { request_id: newId(), ...projectForm } }); await loadProjects(value.id); }
        else { await api('updateProject', { id: project.id, body: { expected_revision: project.revision, name: projectForm.name, property: projectForm.property, scope: projectForm.scope } }); await loadProjects(project.id); }
        setModal(null);
      }); }}><h2>{modal.type === 'create' ? '新建项目' : '编辑项目'}</h2><label>项目名称<input required aria-label="项目名称" maxLength={120} value={projectForm.name} onChange={(event) => setProjectForm({ ...projectForm, name: event.target.value })} placeholder="厨房维修"/></label><label>Property · 房产名称或地址<input aria-label="房产" maxLength={200} value={projectForm.property} onChange={(event) => setProjectForm({ ...projectForm, property: event.target.value })} placeholder="房产 A / 12 King Street"/></label><label>施工需求<textarea aria-label="施工需求" maxLength={4000} value={projectForm.scope} onChange={(event) => setProjectForm({ ...projectForm, scope: event.target.value })} placeholder="更换橱柜和台面，保留地板，包含垃圾清运"/></label><label>比较币种<select aria-label="比较币种" disabled={modal.type === 'edit'} value={projectForm.currency} onChange={(event) => setProjectForm({ ...projectForm, currency: event.target.value })}>{['GBP', 'CNY', 'USD', 'EUR', 'AUD', 'CAD'].map((value) => <option key={value}>{value}</option>)}</select></label><button className="primary" disabled={pending}>保存项目</button></form>}
      {modal.type === 'import' && <><h2>导入报价</h2><p>每个项目最多五份；支持 PDF、图片和粘贴文字。</p><label>承包商名称（选填）<input aria-label="导入承包商" value={importContractorName} onChange={(event) => setImportContractorName(event.target.value)} maxLength={200}/></label><button className="drop-card" disabled={pending} onClick={() => runAction(async () => { const files = await window.desktop.chooseFiles(); if (files.length) await importFiles(files); })}>选择 PDF / 图片文件</button><label className="file-input">或直接拖入文件<input aria-label="导入文件" type="file" accept=".pdf,.png,.jpg,.jpeg,.webp" multiple disabled={pending} onChange={(event) => { const files = [...event.target.files]; if (files.some((file) => file.size > 50 * 1024 * 1024)) { setError('单个文件最大 50MB'); return; } runAction(async () => importFiles(await Promise.all(files.map(async (file) => ({ name: file.name, data: new Uint8Array(await file.arrayBuffer()) }))))); }}/></label><label>粘贴报价文字<textarea aria-label="报价文字" value={paste} onChange={(event) => setPaste(event.target.value)} placeholder="粘贴完整报价…"/></label><button className="primary" disabled={pending || !paste.trim()} onClick={() => runAction(async () => { await api('importQuote', { id: project.id, body: { request_id: newId(), expected_revision: project.revision, source_type: 'text', text: paste, ...(importContractorName ? { contractor_name: importContractorName } : {}) } }); await loadProject(project.id); setModal(null); setPaste(''); setImportContractorName(''); })}>导入文字报价</button></>}
      {['reextract', 'reextractOne'].includes(modal.type) && <><h2>替换人工核对结果？</h2><p>重新提取会替换所选报价的人工修改。已经保存的历史对比不受影响。</p><button className="primary" disabled={pending} onClick={() => runAction(async () => { await startJob({ kind: 'extraction', project_id: project.id, expected_revision: project.revision, quote_ids: modal.type === 'reextractOne' ? [quote.id] : project.quotes.map((item) => item.id), replace_reviewed: true }); setModal(null); })}>确认替换并提取</button></>}
      {modal.type === 'allowPending' && <><h2>保留待确认项？</h2><p>仍有字段未核对。继续会在对比表中明确标注，不当作已确认内容。</p><button className="primary" onClick={() => runAction(async () => { await api('createComparison', { id: project.id, body: { request_id: newId(), expected_revision: project.revision, allow_pending: true } }); await loadProject(project.id); setModal(null); })}>保留待确认项并保存</button></>}
      {(modal.type === 'deleteProject' || modal.type === 'deleteQuote') && <><h2>{modal.type === 'deleteProject' ? '删除整个项目？' : '删除当前报价？'}</h2><p>{modal.type === 'deleteProject' ? '该项目的所有本地报价、历史对比、草稿和报告将删除，用量记录仍保留。' : '当前报价将删除；历史对比中的原文和数据继续保留。'}</p><button className="danger" disabled={pending} onClick={() => runAction(async () => { if (modal.type === 'deleteProject') { await api('deleteProject', { id: project.id, query: { expected_revision: project.revision } }); await loadProjects(''); } else { await api('deleteQuote', { id: modal.quoteId, query: { expected_revision: project.revision } }); await loadProject(project.id); } setModal(null); })}>确认删除</button></>}
      {modal.type === 'evidence' && <><h2>该单元格的原文依据</h2>{modal.refs.length ? modal.refs.map((ref, index) => { const block = modal.source.blocks.find((item) => item.id === ref.block_id); return <div key={index}><p>{modal.source.contractor_name} · {block?.page ? '第 ' + block.page + ' 页' : '粘贴文字'}</p>{block?.page && <FileImage fileId={modal.source.page_file_ids[block.page - 1]} boxes={block.bbox ? [block.bbox] : []}/>}<pre>{block?.text}</pre></div>; }) : <p>该字段未提供，或为人工补充且没有原文依据。</p>}</>}
    </section></div>}
  </div>;
}

createRoot(document.getElementById('root')).render(<App/>);
