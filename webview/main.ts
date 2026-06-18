declare function acquireVsCodeApi(): {
    postMessage(msg: unknown): void;
    getState(): unknown;
    setState(state: unknown): void;
};

interface Commit {
    hash: string;
    shortHash: string;
    subject: string;
    authorName: string;
    authorDate: string;
}

interface CommitDetail {
    hash: string;
    shortHash: string;
    authorName: string;
    authorEmail: string;
    authorDate: string;
    body: string;
}

interface FileChange {
    path: string;
    oldPath?: string;
    status: string;
    additions: number;
    deletions: number;
}

interface InitialState {
    mode: 'log' | 'compare' | 'blame';
    targetPath?: string;
    isFile?: boolean;
    sha1?: string;
    sha2?: string;
    blameSha?: string;
    blameFilePath?: string;
}

const vscode = acquireVsCodeApi();
const state: InitialState = (window as unknown as { initialState: InitialState }).initialState;

let allCommits: Commit[] = [];
let allFiles: FileChange[] = [];
const selectedCommitShas: string[] = [];
let hasMore = true;
let loading = false;

let commitSortColumn: keyof Commit = 'authorDate';
let commitSortAsc = false;
let fileSortColumn: keyof FileChange = 'path';
let fileSortAsc = true;

// --- DOM refs (may be null in compare mode) ---
const commitTbody = document.getElementById('commit-tbody') as HTMLTableSectionElement | null;
const commitDetailPanel = document.getElementById('commit-detail-panel');
const filesTbody = document.getElementById('files-tbody') as HTMLTableSectionElement;
const loadMore = document.getElementById('load-more');
const contextMenu = document.getElementById('context-menu')!;
const commitContextMenu = document.getElementById('commit-context-menu');

// --- Sorting ---

function sortArray<T>(arr: T[], key: keyof T, asc: boolean): T[] {
    return [...arr].sort((a, b) => {
        const va = a[key];
        const vb = b[key];
        if (typeof va === 'number' && typeof vb === 'number') {
            return asc ? va - vb : vb - va;
        }
        const sa = String(va);
        const sb = String(vb);
        return asc ? sa.localeCompare(sb) : sb.localeCompare(sa);
    });
}

function updateSortArrows(tableId: string, column: string, asc: boolean): void {
    const table = document.getElementById(tableId);
    if (!table) return;
    table.querySelectorAll('th .sort-arrow').forEach(el => el.textContent = '');
    const th = table.querySelector(`th[data-col="${column}"]`);
    if (th) {
        const arrow = th.querySelector('.sort-arrow');
        if (arrow) {
            arrow.textContent = asc ? ' ▲' : ' ▼';
        }
    }
}

// --- Commit list rendering (log mode only) ---

function renderCommits(): void {
    if (!commitTbody) return;
    const sorted = sortArray(allCommits, commitSortColumn, commitSortAsc);
    commitTbody.innerHTML = '';
    for (const commit of sorted) {
        const tr = document.createElement('tr');
        tr.className = 'data-row';
        if (selectedCommitShas.includes(commit.hash)) {
            tr.classList.add('selected');
        }
        tr.dataset.sha = commit.hash;

        const tdSha = document.createElement('td');
        tdSha.className = 'col-sha';
        tdSha.textContent = commit.shortHash;
        tr.appendChild(tdSha);

        const tdMsg = document.createElement('td');
        tdMsg.className = 'col-message';
        tdMsg.textContent = commit.subject;
        tdMsg.title = commit.subject;
        tr.appendChild(tdMsg);

        const tdAuthor = document.createElement('td');
        tdAuthor.className = 'col-author';
        tdAuthor.textContent = commit.authorName;
        tr.appendChild(tdAuthor);

        const tdDate = document.createElement('td');
        tdDate.className = 'col-date';
        tdDate.textContent = formatDate(commit.authorDate);
        tr.appendChild(tdDate);

        tr.addEventListener('click', (e) => onCommitClick(commit.hash, e));
        tr.addEventListener('contextmenu', (e) => showCommitContextMenu(e));
        commitTbody.appendChild(tr);
    }
}

function formatDate(isoDate: string): string {
    try {
        const d = new Date(isoDate);
        return d.toLocaleString();
    } catch {
        return isoDate;
    }
}

function onCommitClick(sha: string, e: MouseEvent): void {
    if (e.ctrlKey || e.metaKey) {
        const idx = selectedCommitShas.indexOf(sha);
        if (idx >= 0) {
            selectedCommitShas.splice(idx, 1);
        } else {
            if (selectedCommitShas.length >= 2) {
                selectedCommitShas.shift();
            }
            selectedCommitShas.push(sha);
        }
    } else {
        selectedCommitShas.length = 0;
        selectedCommitShas.push(sha);
    }

    if (commitTbody) {
        commitTbody.querySelectorAll('tr').forEach(tr => {
            tr.classList.toggle('selected', selectedCommitShas.includes(tr.dataset.sha || ''));
        });
    }

    if (selectedCommitShas.length === 1) {
        vscode.postMessage({ type: 'requestCommitDetails', sha });
    }
}

// --- Commit context menu (log mode) ---

function showCommitContextMenu(e: MouseEvent): void {
    if (!commitContextMenu || selectedCommitShas.length < 2) return;
    e.preventDefault();
    e.stopPropagation();
    commitContextMenu.style.display = 'block';
    commitContextMenu.style.left = `${e.clientX}px`;
    commitContextMenu.style.top = `${e.clientY}px`;
    clampMenu(commitContextMenu);
}

function hideCommitContextMenu(): void {
    if (commitContextMenu) {
        commitContextMenu.style.display = 'none';
    }
}

if (document.getElementById('ctx-compare-revisions')) {
    document.getElementById('ctx-compare-revisions')!.addEventListener('click', () => {
        if (selectedCommitShas.length === 2) {
            vscode.postMessage({
                type: 'compareRevisions',
                sha1: selectedCommitShas[0],
                sha2: selectedCommitShas[1],
            });
        }
        hideCommitContextMenu();
    });
}

// --- Commit detail rendering (log mode) ---

function renderCommitDetail(detail: CommitDetail): void {
    if (!commitDetailPanel) return;
    commitDetailPanel.innerHTML = '';

    const shaLine = document.createElement('div');
    shaLine.innerHTML = `<span class="detail-label">SHA-1: </span><span class="detail-sha">${escapeHtml(detail.hash)}</span>`;
    commitDetailPanel.appendChild(shaLine);

    const authorLine = document.createElement('div');
    authorLine.innerHTML = `<span class="detail-label">Author: </span>${escapeHtml(detail.authorName)} &lt;${escapeHtml(detail.authorEmail)}&gt;`;
    commitDetailPanel.appendChild(authorLine);

    const dateLine = document.createElement('div');
    dateLine.innerHTML = `<span class="detail-label">Date: </span>${escapeHtml(formatDate(detail.authorDate))}`;
    commitDetailPanel.appendChild(dateLine);

    if (detail.body) {
        const bodyDiv = document.createElement('div');
        bodyDiv.className = 'detail-body';
        bodyDiv.textContent = detail.body;
        commitDetailPanel.appendChild(bodyDiv);
    }
}

// --- Compare detail panes (compare mode) ---

function renderCompareDetail(panelId: string, detail: CommitDetail): void {
    const panel = document.getElementById(panelId);
    if (!panel) return;
    panel.innerHTML = '';

    const shaLine = document.createElement('div');
    shaLine.innerHTML = `<span class="detail-label">SHA-1: </span><span class="detail-sha">${escapeHtml(detail.shortHash)}</span>`;
    panel.appendChild(shaLine);

    const authorLine = document.createElement('div');
    authorLine.innerHTML = `<span class="detail-label">Author: </span>${escapeHtml(detail.authorName)} &lt;${escapeHtml(detail.authorEmail)}&gt;`;
    panel.appendChild(authorLine);

    const dateLine = document.createElement('div');
    dateLine.innerHTML = `<span class="detail-label">Date: </span>${escapeHtml(formatDate(detail.authorDate))}`;
    panel.appendChild(dateLine);

    if (detail.body) {
        const bodyDiv = document.createElement('div');
        bodyDiv.className = 'detail-body';
        bodyDiv.textContent = detail.body;
        panel.appendChild(bodyDiv);
    }
}

// --- Files list rendering (shared between both modes) ---

function renderFiles(): void {
    const sorted = sortArray(allFiles, fileSortColumn, fileSortAsc);
    filesTbody.innerHTML = '';
    for (const file of sorted) {
        const tr = document.createElement('tr');
        tr.className = 'data-row';
        tr.dataset.path = file.path;
        tr.dataset.status = file.status;
        if (file.oldPath) {
            tr.dataset.oldPath = file.oldPath;
        }

        const tdPath = document.createElement('td');
        tdPath.className = 'col-path';
        const displayPath = file.status === 'R' && file.oldPath
            ? `${file.oldPath} → ${file.path}`
            : file.path;
        tdPath.textContent = displayPath;
        tdPath.title = displayPath;
        tr.appendChild(tdPath);

        const tdStatus = document.createElement('td');
        tdStatus.className = `col-status status-${statusClass(file.status)}`;
        tdStatus.textContent = statusLabel(file.status);
        tr.appendChild(tdStatus);

        const tdAdd = document.createElement('td');
        tdAdd.className = 'col-additions';
        tdAdd.textContent = file.additions > 0 ? `+${file.additions}` : '0';
        tr.appendChild(tdAdd);

        const tdDel = document.createElement('td');
        tdDel.className = 'col-deletions';
        tdDel.textContent = file.deletions > 0 ? `-${file.deletions}` : '0';
        tr.appendChild(tdDel);

        tr.addEventListener('contextmenu', (e) => showFileContextMenu(e, file));
        tr.addEventListener('dblclick', () => {
            if (state.mode === 'compare') {
                vscode.postMessage({
                    type: 'compareFile',
                    filePath: file.path,
                    oldPath: file.oldPath,
                    status: file.status,
                });
            } else if (selectedCommitShas.length >= 1) {
                vscode.postMessage({
                    type: 'compareWithPrevious',
                    sha: selectedCommitShas[selectedCommitShas.length - 1],
                    filePath: file.path,
                    oldPath: file.oldPath,
                    status: file.status,
                });
            }
        });
        filesTbody.appendChild(tr);
    }
}

function statusClass(s: string): string {
    switch (s) {
        case 'A': return 'added';
        case 'M': return 'modified';
        case 'D': return 'deleted';
        case 'R': return 'renamed';
        default: return 'modified';
    }
}

function statusLabel(s: string): string {
    switch (s) {
        case 'A': return 'Added';
        case 'M': return 'Modified';
        case 'D': return 'Deleted';
        case 'R': return 'Renamed';
        case 'C': return 'Copied';
        default: return s;
    }
}

function escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// --- File context menu (shared) ---

let contextFile: FileChange | null = null;

function showFileContextMenu(e: MouseEvent, file: FileChange): void {
    if (state.mode === 'log' && selectedCommitShas.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    contextFile = file;
    contextMenu.style.display = 'block';
    contextMenu.style.left = `${e.clientX}px`;
    contextMenu.style.top = `${e.clientY}px`;

    // Show/hide items based on mode
    const compareItem = document.getElementById('ctx-compare')!;
    const blameItem = document.getElementById('ctx-blame')!;
    const compareFileItem = document.getElementById('ctx-compare-file');
    const showLogItem = document.getElementById('ctx-show-file-log')!;

    if (state.mode === 'log') {
        compareItem.style.display = '';
        blameItem.style.display = '';
        if (compareFileItem) compareFileItem.style.display = 'none';
    } else {
        compareItem.style.display = 'none';
        blameItem.style.display = 'none';
        if (compareFileItem) compareFileItem.style.display = '';
    }
    showLogItem.style.display = '';

    clampMenu(contextMenu);
}

function hideFileContextMenu(): void {
    contextMenu.style.display = 'none';
    contextFile = null;
}

function clampMenu(menu: HTMLElement): void {
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
        menu.style.left = `${window.innerWidth - rect.width}px`;
    }
    if (rect.bottom > window.innerHeight) {
        menu.style.top = `${window.innerHeight - rect.height}px`;
    }
}

// Log mode: Compare with Previous
document.getElementById('ctx-compare')!.addEventListener('click', () => {
    if (contextFile && selectedCommitShas.length >= 1) {
        vscode.postMessage({
            type: 'compareWithPrevious',
            sha: selectedCommitShas[selectedCommitShas.length - 1],
            filePath: contextFile.path,
            oldPath: contextFile.oldPath,
            status: contextFile.status,
        });
    }
    hideFileContextMenu();
});

// Log mode: Blame
document.getElementById('ctx-blame')!.addEventListener('click', () => {
    if (contextFile && selectedCommitShas.length >= 1) {
        vscode.postMessage({
            type: 'blame',
            sha: selectedCommitShas[selectedCommitShas.length - 1],
            filePath: contextFile.path,
        });
    }
    hideFileContextMenu();
});

// Compare mode: Compare file between the two revisions
if (document.getElementById('ctx-compare-file')) {
    document.getElementById('ctx-compare-file')!.addEventListener('click', () => {
        if (contextFile) {
            vscode.postMessage({
                type: 'compareFile',
                filePath: contextFile.path,
                oldPath: contextFile.oldPath,
                status: contextFile.status,
            });
        }
        hideFileContextMenu();
    });
}

// Both modes: Show file log
document.getElementById('ctx-show-file-log')!.addEventListener('click', () => {
    if (contextFile) {
        vscode.postMessage({
            type: 'showFileLog',
            filePath: contextFile.path,
        });
    }
    hideFileContextMenu();
});

document.addEventListener('click', () => {
    hideFileContextMenu();
    hideCommitContextMenu();
});
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        hideFileContextMenu();
        hideCommitContextMenu();
    }
});

// --- Column sorting handlers ---

document.querySelectorAll('#commit-table th[data-col]').forEach(th => {
    th.addEventListener('click', () => {
        const col = (th as HTMLElement).dataset.col as keyof Commit;
        if (commitSortColumn === col) {
            commitSortAsc = !commitSortAsc;
        } else {
            commitSortColumn = col;
            commitSortAsc = true;
        }
        updateSortArrows('commit-table', col, commitSortAsc);
        renderCommits();
    });
});

document.querySelectorAll('#files-table th[data-col]').forEach(th => {
    th.addEventListener('click', () => {
        const col = (th as HTMLElement).dataset.col as keyof FileChange;
        if (fileSortColumn === col) {
            fileSortAsc = !fileSortAsc;
        } else {
            fileSortColumn = col;
            fileSortAsc = true;
        }
        updateSortArrows('files-table', col, fileSortAsc);
        renderFiles();
    });
});

// --- Infinite scroll (log mode only) ---

if (loadMore) {
    const observer = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting && hasMore && !loading) {
            requestMoreCommits();
        }
    });
    observer.observe(loadMore);
}

function requestMoreCommits(): void {
    loading = true;
    if (loadMore) loadMore.textContent = 'Loading...';
    vscode.postMessage({ type: 'requestCommits', offset: allCommits.length, count: 100 });
}

// --- Panel resizing ---

document.querySelectorAll('.resizer').forEach(resizer => {
    let startY = 0;
    let startRows: number[] = [];

    const el = resizer as HTMLElement;
    const app = document.getElementById('app')!;

    el.addEventListener('mousedown', (e: Event) => {
        const me = e as MouseEvent;
        startY = me.clientY;
        const computed = getComputedStyle(app);
        startRows = computed.gridTemplateRows.split(' ').map(v => parseFloat(v));
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        e.preventDefault();
    });

    function onMouseMove(e: MouseEvent): void {
        const resizerIndex = Array.from(app.children).indexOf(el);
        const panelAbove = resizerIndex - 1;
        const panelBelow = resizerIndex + 1;
        const delta = e.clientY - startY;
        const newRows = [...startRows];
        newRows[panelAbove] = Math.max(50, startRows[panelAbove] + delta);
        newRows[panelBelow] = Math.max(50, startRows[panelBelow] - delta);
        app.style.gridTemplateRows = newRows.map(v => `${v}px`).join(' ');
    }

    function onMouseUp(): void {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
    }
});

// --- Blame mode rendering ---

interface BlameLineData {
    sha: string;
    shortSha: string;
    author: string;
    authorEmail: string;
    timestamp: number;
    date: string;
    summary: string;
    lineNo: number;
    content: string;
}

let blameCommits: Record<string, CommitDetail> = {};
let blameLockedSha: string | null = null;

function renderBlame(lines: BlameLineData[], commits: Record<string, CommitDetail>): void {
    blameCommits = commits;
    const gutterTbody = document.getElementById('blame-gutter-tbody') as HTMLTableSectionElement;
    const codeTbody = document.getElementById('blame-code-tbody') as HTMLTableSectionElement;
    if (!gutterTbody || !codeTbody) return;

    const shaColors = new Map<string, string>();
    const uniqueShas = [...new Set(lines.map(l => l.sha))];
    for (let i = 0; i < uniqueShas.length; i++) {
        const hue = (i * 47) % 360;
        shaColors.set(uniqueShas[i], `hsla(${hue}, 40%, 50%, 0.12)`);
    }

    let prevSha = '';
    for (const line of lines) {
        const isNewBlock = line.sha !== prevSha;
        const bgColor = shaColors.get(line.sha) || 'transparent';

        const gutterRow = document.createElement('tr');
        gutterRow.className = 'blame-row';
        gutterRow.dataset.sha = line.sha;
        gutterRow.style.backgroundColor = bgColor;

        const tdSha = document.createElement('td');
        tdSha.className = 'blame-sha';
        tdSha.textContent = isNewBlock ? line.shortSha : '';
        gutterRow.appendChild(tdSha);

        const tdAuthor = document.createElement('td');
        tdAuthor.className = 'blame-author';
        tdAuthor.textContent = isNewBlock ? line.author : '';
        gutterRow.appendChild(tdAuthor);

        const tdDate = document.createElement('td');
        tdDate.className = 'blame-date';
        tdDate.textContent = isNewBlock ? formatTimeAgo(line.timestamp) : '';
        gutterRow.appendChild(tdDate);

        gutterRow.addEventListener('mouseenter', () => onBlameHover(line.sha));
        gutterRow.addEventListener('click', () => onBlameClick(line.sha));
        gutterTbody.appendChild(gutterRow);

        const codeRow = document.createElement('tr');
        codeRow.className = 'blame-row';
        codeRow.dataset.sha = line.sha;
        codeRow.style.backgroundColor = bgColor;

        const tdLineNo = document.createElement('td');
        tdLineNo.className = 'blame-line-no';
        tdLineNo.textContent = String(line.lineNo);
        codeRow.appendChild(tdLineNo);

        const tdCode = document.createElement('td');
        tdCode.className = 'blame-code';
        tdCode.textContent = line.content;
        codeRow.appendChild(tdCode);

        codeRow.addEventListener('mouseenter', () => onBlameHover(line.sha));
        codeRow.addEventListener('click', () => onBlameClick(line.sha));
        codeTbody.appendChild(codeRow);

        prevSha = line.sha;
    }

    // Sync scroll between gutter and code
    const gutterPanel = document.getElementById('blame-gutter-panel');
    const codePanel = document.getElementById('blame-code-panel');
    if (gutterPanel && codePanel) {
        let syncing = false;
        gutterPanel.addEventListener('scroll', () => {
            if (syncing) return;
            syncing = true;
            codePanel.scrollTop = gutterPanel.scrollTop;
            syncing = false;
        });
        codePanel.addEventListener('scroll', () => {
            if (syncing) return;
            syncing = true;
            gutterPanel.scrollTop = codePanel.scrollTop;
            syncing = false;
        });
    }
}

function onBlameHover(sha: string): void {
    if (blameLockedSha) return;
    highlightBlameSha(sha);
    showBlameCommitInfo(sha);
}

function onBlameClick(sha: string): void {
    if (blameLockedSha === sha) {
        blameLockedSha = null;
        highlightBlameSha('');
        const infoPanel = document.getElementById('blame-commit-info');
        if (infoPanel) {
            infoPanel.innerHTML = '<div class="empty-state">Hover over a revision to see commit details</div>';
        }
    } else {
        blameLockedSha = sha;
        highlightBlameSha(sha);
        showBlameCommitInfo(sha);
    }
}

function highlightBlameSha(sha: string): void {
    document.querySelectorAll('.blame-row').forEach(row => {
        const el = row as HTMLElement;
        if (sha && el.dataset.sha === sha) {
            el.classList.add('blame-highlight');
        } else {
            el.classList.remove('blame-highlight');
        }
    });
}

function showBlameCommitInfo(sha: string): void {
    const infoPanel = document.getElementById('blame-commit-info');
    if (!infoPanel) return;
    const detail = blameCommits[sha];
    if (!detail) return;

    infoPanel.innerHTML = '';

    const shaLine = document.createElement('div');
    shaLine.innerHTML = `<span class="detail-label">SHA-1: </span><span class="detail-sha">${escapeHtml(detail.hash)}</span>`;
    infoPanel.appendChild(shaLine);

    const authorLine = document.createElement('div');
    authorLine.innerHTML = `<span class="detail-label">Author: </span>${escapeHtml(detail.authorName)} &lt;${escapeHtml(detail.authorEmail)}&gt;`;
    infoPanel.appendChild(authorLine);

    const dateLine = document.createElement('div');
    dateLine.innerHTML = `<span class="detail-label">Date: </span>${escapeHtml(formatDate(detail.authorDate))}`;
    infoPanel.appendChild(dateLine);

    const subjectLine = document.createElement('div');
    subjectLine.innerHTML = `<span class="detail-label">Subject: </span>${escapeHtml(detail.body.split('\n')[0])}`;
    infoPanel.appendChild(subjectLine);

    const bodyText = detail.body.split('\n').slice(1).join('\n').trim();
    if (bodyText) {
        const bodyDiv = document.createElement('div');
        bodyDiv.className = 'detail-body';
        bodyDiv.textContent = bodyText;
        infoPanel.appendChild(bodyDiv);
    }
}

function formatTimeAgo(timestamp: number): string {
    const seconds = Math.floor(Date.now() / 1000 - timestamp);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months}mo ago`;
    const years = Math.floor(days / 365);
    return `${years}y ago`;
}

// --- Message handling ---

window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
        case 'commitsLoaded': {
            const newCommits: Commit[] = msg.commits;
            allCommits = allCommits.concat(newCommits);
            hasMore = msg.hasMore;
            loading = false;
            renderCommits();
            if (!hasMore && loadMore) {
                loadMore.style.display = 'none';
            } else if (loadMore) {
                loadMore.textContent = 'Scroll for more...';
            }
            if (allCommits.length > 0 && selectedCommitShas.length === 0) {
                onCommitClick(allCommits[0].hash, new MouseEvent('click'));
            }
            break;
        }
        case 'commitDetailsLoaded': {
            renderCommitDetail(msg.detail);
            allFiles = msg.files;
            fileSortColumn = 'path';
            fileSortAsc = true;
            updateSortArrows('files-table', 'path', true);
            renderFiles();
            break;
        }
        case 'compareFilesLoaded': {
            if (msg.detail1) renderCompareDetail('compare-detail-1', msg.detail1);
            if (msg.detail2) renderCompareDetail('compare-detail-2', msg.detail2);
            allFiles = msg.files;
            fileSortColumn = 'path';
            fileSortAsc = true;
            updateSortArrows('files-table', 'path', true);
            renderFiles();
            break;
        }
        case 'blameDataLoaded': {
            renderBlame(msg.lines, msg.commits);
            break;
        }
        case 'error': {
            if (commitDetailPanel) {
                commitDetailPanel.innerHTML = `<div class="empty-state">${escapeHtml(msg.message)}</div>`;
            }
            break;
        }
    }
});

// --- Init ---
if (state.mode === 'log') {
    requestMoreCommits();
} else if (state.mode === 'compare') {
    vscode.postMessage({ type: 'requestCompareFiles' });
} else if (state.mode === 'blame') {
    vscode.postMessage({ type: 'requestBlameData' });
}
