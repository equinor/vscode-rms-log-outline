import * as vscode from 'vscode';

// --- Translated from python/parser3.py ---
interface JobBlock {
    level: number | null;
    title: string;
    content: string;
    start: number;
    end: number;
    elapsed?: number | null;
    realization?: number | null;
    titleLine?: number | null;
}

function loadAndPreprocess(html: string): string {
    html = html.replace(/( - deactivated)(?=(\r?\n|$))/g, '$1</pre>');

    return html;
}

function inferDomDepthUpTo(html: string, pos: number): number {
    // crude HTML parser to count open non-void tags up to pos
    const voidTags = new Set(["area","base","br","col","embed","hr","img","input","link","meta","param","source","track","wbr"]);
    let depth = 0;
    const tagRegex = /<\/?([a-zA-Z0-9_-]+)(?:\s[^>]*)?>/g;
    tagRegex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = tagRegex.exec(html)) && m.index < pos) {
        const full = m[0];
        const name = (m[1] || '').toLowerCase();
        if (full.startsWith('</')) {
            if (depth > 0) {depth -= 1;}
        } else if (!full.endsWith('/>') && !voidTags.has(name)) {
            depth += 1;
        }
    }
    return depth;
}


function parseJobBlocks(htmlIn: string, originalHtml?: string): JobBlock[] {
    const html = htmlIn;
    const blocks: JobBlock[] = [];
    const re = /<pre\b([^>]*)>([\s\S]*?)<\/pre>/gi;
    let m: RegExpExecArray | null;
    let lastFoundPos = 0;
    while ((m = re.exec(html)) !== null) {
        const attrStr = m[1] || '';
        const content = m[2] || '';
        let contentNorm = content.replace(/\r/g, '');
        // Extract "- for project realization N" into metadata and remove from content
        let realization: number | null = null;
        const realizationMatch = /\s*-\s*for\s+project\s+realization\s*(\d+)\b/i.exec(contentNorm);
        if (realizationMatch) {
            const r = parseInt(realizationMatch[1], 10);
            if (!Number.isNaN(r)) { realization = r; }
            contentNorm = contentNorm.replace(/\s*-\s*for\s+project\s+realization\s*(\d+)\b/gi, '');
        }
        // Remove any HTML tags from the normalized content so contentNorm is tag-free
        contentNorm = contentNorm.replace(/<[^>]*>/g, '');
        // Decode common HTML entities (numeric and a few named ones)
        contentNorm = decodeHtmlEntities(contentNorm);
        // Collapse multiple spaces/tabs within each line and trim lines
        let lines = contentNorm.split('\n').map(l => l.replace(/[\t ]+/g, ' ').trimEnd());
        // Remove leading/trailing blank lines
        while (lines.length && lines[0].trim() === '') { lines.shift(); }
        while (lines.length && lines[lines.length-1].trim() === '') { lines.pop(); }
        contentNorm = lines.join('\n');
        let title = '';
        for (const ln of contentNorm.split('\n')) {
            const ln_strip = ln.trim();
            if (ln_strip) { title = ln_strip; break; }
        }

        // If title indicates skipped or deactivated, mark elapsed = 0
        const titleLower = title.toLowerCase();
        const titleIndicatesZero = /(?:-\s*skipped|-\s*deactivated)\s*$/.test(titleLower);

        // // Also normalize title if it contains the phrase
        // title = title.replace(/\s*-\s*for\s+project\s+realization\s*(\d+)\b/gi, ' #$1');

        let level: number | null = null;
        try {
            level = inferDomDepthUpTo(html, m.index);
        } catch (e) {
            level = null;
        }

        // Extract elapsed time after the </pre> (store as seconds)
        let elapsed: number | null = null;
        if (titleIndicatesZero) {
            elapsed = 0;
        }
        // limit search to the next <pre (if present) to avoid crossing into following blocks
        const searchStart = m.index + m[0].length;
        const nextPre = html.indexOf('<pre', searchStart);
        const searchEnd = nextPre !== -1 ? Math.min(nextPre, searchStart + 400, html.length) : Math.min(html.length, searchStart + 400);
        const afterChunk = html.substring(searchStart, searchEnd);
        if (afterChunk) {
            // Expected fixed format: h:mm:ss.ms (e.g. 0:00:01.0)
            // look for the labeled form first ("Elapsed time: 0:00:01.0") or just the time
            let me = /(?:elapsed|elapsed time|elapse|took|duration)[:\s]*([0-9]+:[0-5][0-9]:[0-5][0-9]\.[0-9]+)/i.exec(afterChunk as string);
            if (!me) { me = /([0-9]+:[0-5][0-9]:[0-5][0-9]\.[0-9]+)/.exec(afterChunk as string); }
            if (me) {
                const raw = me[1].trim();
                const secs = parseDurationToSeconds(raw);
                elapsed = secs; // parseDurationToSeconds will return null only for unexpected input
            }
        }

        // Map start/end back to originalHtml if provided; otherwise use processed offsets
        let startPos = m.index;
        let endPos = m.index + m[0].length;
        if (originalHtml) {
            // Try to find the content occurrence in original starting from lastFoundPos
            const searchFrom = Math.max(0, lastFoundPos);
            // const searchFrom = 0; // AB
            // let contentIndex = originalHtml.indexOf(contentNorm, searchFrom); AB
            let contentIndex = originalHtml.indexOf(content, searchFrom);
            if (contentIndex !== -1) {
                // find nearest <pre before contentIndex
                const preStart = originalHtml.lastIndexOf('<pre', contentIndex);
                if (preStart !== -1) {
                    startPos = preStart;
                    // find closing </pre> after contentIndex
                    // Find next tag
                    const nextCloseTag = originalHtml.indexOf('>', contentIndex + content.length);
                    const closePos = originalHtml.indexOf('</pre>', contentIndex + content.length);
                    if (closePos !== -1 && closePos < nextCloseTag) {
                        endPos = closePos + 6;
                    } else {
                        const nextPreTag = originalHtml.indexOf('<pre>', contentIndex + content.length);
                        if (nextPreTag !== -1 && nextCloseTag !== -1 && nextPreTag < nextCloseTag) {
                            endPos = nextPreTag-1;
                        }
                        else {
                            endPos = contentIndex + content.length;
                        }
                    }
                    lastFoundPos = endPos;
                    // compute title line number if possible
                    try {
                            // Derive title line by scanning the original <pre> inner text for
                            // the first non-empty line. This avoids mismatches caused by
                            // normalizing/stripping tags/entities when computing the title.
                            const openTagEnd = originalHtml.indexOf('>', preStart);
                            const innerStart = openTagEnd !== -1 ? openTagEnd + 1 : preStart;
                            const innerEnd = (closePos !== -1) ? closePos : Math.min(originalHtml.length, contentIndex + content.length);
                            if (innerEnd > innerStart) {
                                const inner = originalHtml.slice(innerStart, innerEnd);
                                const innerLines = inner.split('\n');
                                // find index of first non-empty line inside the pre
                                let innerLineIndex = -1;
                                for (let i = 0; i < innerLines.length; i++) {
                                    if (innerLines[i].trim()) { innerLineIndex = i; break; }
                                }
                                if (innerLineIndex >= 0) {
                                    // compute absolute title line as number of lines before innerStart plus innerLineIndex
                                    const beforePre = originalHtml.slice(0, innerStart);
                                    const preStartLine = beforePre.split('\n').length - 1;
                                    (m as any)._titleLine = preStartLine + innerLineIndex;
                                } else {
                                    (m as any)._titleLine = null;
                                }
                            }
                    } catch (e) {
                        // ignore
                    }
                } else {
                    // as a last resort, set start at contentIndex
                    startPos = contentIndex;
                    endPos = contentIndex + content.length;
                    lastFoundPos = endPos;
                }
            }
        }
        const titleLine = (m as any)._titleLine !== undefined ? (m as any)._titleLine : null;
        blocks.push({ level, title, content: contentNorm, start: startPos, end: endPos, elapsed, realization, titleLine });
    }

    return blocks;
}


// Decode basic HTML entities including numeric references and a few named entities used in logs
function decodeHtmlEntities(s: string): string {
    if (!s) { return s; }
    // Replace numeric entities: &#123; or &#x7B;
    s = s.replace(/&#(x?[0-9a-fA-F]+);?/g, (_m, n) => {
        try {
            if (n.startsWith('x') || n.startsWith('X')) {
                return String.fromCharCode(parseInt(n.slice(1), 16));
            }
            return String.fromCharCode(parseInt(n, 10));
        } catch (e) {
            return '';
        }
    });
    // Common named entities
    const named: Record<string,string> = {
        'nbsp': ' ',
        'lt': '<', 'gt': '>', 'amp': '&', 'quot': '"', 'apos': "'"
    };
    s = s.replace(/&([a-zA-Z]+);?/g, (m, name) => {
        const key = name.toLowerCase();
        if (named[key]) { return named[key]; }
        return m;
    });
    return s;
}

// Parse a duration string (supports ms, s, sec, secs, seconds and colon formats)
function parseDurationToSeconds(s: string): number | null {
    if (!s) { return null; }
    const str = s.trim();
    // expect h:mm:ss.ms where h may be multiple digits, ms is fractional seconds (at least one digit)
    const m = /^([0-9]+):([0-5][0-9]):([0-5][0-9])\.([0-9]+)$/.exec(str);
    if (!m) { return null; }
    const hh = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    const ss = parseInt(m[3], 10);
    const fracStr = '0.' + m[4];
    const frac = parseFloat(fracStr);
    return hh * 3600 + mm * 60 + ss + frac;
}

function formatSeconds(secs: number): string {
    if (!isFinite(secs)) { return String(secs); }
    const abs = Math.abs(secs);
    // Hours / minutes formatting when appropriate
    if (abs >= 3600) {
        const hh = Math.floor(secs / 3600);
        const rem = secs - hh * 3600;
        const mm = Math.floor(rem / 60);
        const ss = +(rem - mm * 60).toFixed(3);
        return `${hh} hr ${String(mm).padStart(2, '0')} mins ${ss}s`;
    }
    if (abs >= 60) {
        const mm = Math.floor(secs / 60);
        const ss = +(secs - mm * 60).toFixed(3);
        return `${mm} mins ${ss}s`;
    }
    // show up to 3 decimal places but trim trailing zeros for seconds < 60
    const s = abs < 1e-3 ? secs.toFixed(6) : secs.toFixed(3);
    const trimmed = s.replace(/\.?(?:0+)$/, '');
    return `${trimmed}s`;
}

export function activate(context: vscode.ExtensionContext) {

    // Register JobBlocks Tree View provider (hierarchical)
    const provider = new JobBlocksProvider(context);
    const treeView = vscode.window.createTreeView('rmsJobBlock', { treeDataProvider: provider });
    provider.attachTreeView(treeView);
    context.subscriptions.push(treeView);

    // Register Custom Editor Provider
    context.subscriptions.push(RmsLogEditorProvider.register(context, provider));

    // Add a refresh command for the view
    context.subscriptions.push(vscode.commands.registerCommand('rms-log-outline.refreshJobBlocks', () => provider.refresh()));

    // Register search command (toolbar button)
    context.subscriptions.push(vscode.commands.registerCommand('rms-log-outline.searchJob', async () => {
        const q = await vscode.window.showInputBox({ prompt: 'Search by title (substring match)', placeHolder: 'enter job title or text' });
        if (!q || !q.trim()) { return; }
        await provider.searchAndReveal(q.trim());
    }));

    // Command to reveal a block (used by both Explorer tree and webview)
    context.subscriptions.push(vscode.commands.registerCommand('rms-log-outline.revealBlock', (block: JobBlock) => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            // Try to reveal in custom editor if available
            provider.postHighlightToWebview(block.start, block.end, block.titleLine ?? undefined);
            return;
        }
        const doc = editor.document;
        if (block.titleLine !== undefined && block.titleLine !== null) {
            try {
                const ln = Math.max(0, block.titleLine);
                const textLine = doc.lineAt(ln);
                const rangeLine = textLine.range; // full line range
                vscode.window.showTextDocument(doc.uri).then(ed => {
                    ed.revealRange(rangeLine, vscode.TextEditorRevealType.InCenter);
                    ed.selection = new vscode.Selection(rangeLine.start, rangeLine.end);
                    provider.postHighlightToWebview(block.start, block.end, block.titleLine ?? undefined);
                });
                return;
            } catch (e) {
                // fallback to full range
            }
        }

        const startPos = doc.positionAt(block.start);
        const endPos = doc.positionAt(block.end);
        const range = new vscode.Range(startPos, endPos);
        vscode.window.showTextDocument(doc.uri).then(ed => {
            ed.revealRange(range, vscode.TextEditorRevealType.InCenter);
            ed.selection = new vscode.Selection(startPos, endPos);
            // also inform webview (if present) to highlight the same range (include titleLine if available)
            provider.postHighlightToWebview(block.start, block.end, block.titleLine ?? undefined);
        });
    }));

    // Expand/collapse commands for tree view items (context menu)
    context.subscriptions.push(vscode.commands.registerCommand('rms-log-outline.expandNode', async (node) => {
        if (!node) { return; }
        await treeView.reveal(node, { expand: true });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('rms-log-outline.collapseNode', async (node) => {
        if (!node) { return; }
        await treeView.reveal(node, { expand: false });
    }));

    // Expand/collapse all
    context.subscriptions.push(vscode.commands.registerCommand('rms-log-outline.expandAll', async () => {
        // expand all root nodes
        const roots = await provider.getChildren();
        for (const r of roots) {
            await treeView.reveal(r, { expand: true });
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('rms-log-outline.collapseAll', async () => {
        const roots = await provider.getChildren();
        for (const r of roots) {
            await treeView.reveal(r, { expand: false });
        }
    }));

    // Auto-refresh when active editor or document content changes
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor((e) => {
        if (e) {
            // If a text editor becomes active, clear the custom document override
            provider.setActiveCustomDocument(undefined);
        }
        provider.refresh();
    }));
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(() => provider.refresh()));

    // Refresh tree when folder icon color settings change
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('rms_log_outline.folderIconLight') || e.affectsConfiguration('rms_log_outline.folderIconDark')) {
            provider.refresh();
        }
    }));

}

class JobBlockNode extends vscode.TreeItem {
    children: JobBlockNode[] = [];

    static makeFolderIcon(indentPx: number): { light: vscode.Uri, dark: vscode.Uri } {
        const width = 24;
        const height = 24;
        const cap = Math.min(indentPx, 12);
        const tx = cap;
        // scale original 256x256 SVG into 24x24 canvas
        const scale = 24 / 256;


        // path from user-provided SVG (flattened)
        const pathD = `M241.88037,110.64453A16.03934,16.03934,0,0,0,228.90039,104H216V88a16.01833,16.01833,0,0,0-16-16H130.667l-27.7334-20.7998A16.10323,16.10323,0,0,0,93.333,48H40A16.01833,16.01833,0,0,0,24,64V208c0,.05127.00684.10059.00781.15137.002.1123.00977.22412.0166.33642.01172.19043.02832.37891.05274.56592q.02051.15234.04639.30371c.03515.20459.07861.40576.1289.605.021.08252.04.16553.064.24756.06836.23877.14843.47217.23779.70117.0166.042.02978.08545.04687.12793a7.867,7.867,0,0,0,.39014.81592c.01563.02881.03467.05566.05078.084q.1919.33912.41553.65625c.019.02686.0332.05567.05225.08252.03564.04883.07763.09082.11377.13916.12255.16163.24951.31885.38378.47022.06836.07764.13672.1543.20752.22851.14161.14844.29.29.44287.42725.064.05713.125.11768.19043.17285a7.94692,7.94692,0,0,0,.69581.52832l.01953.01172a7.96822,7.96822,0,0,0,.73632.43311c.064.0332.12989.0625.19483.09375.19971.09765.40332.18847.61182.26953.0791.03027.1582.05859.23828.08691q.30176.1062.61377.188c.08447.02246.168.04541.25293.06494.21386.04883.43164.08643.65185.11817.0791.01123.15674.02685.23633.03613A8.06189,8.06189,0,0,0,32,216H208a8.00117,8.00117,0,0,0,7.58984-5.47021l28.48926-85.47022A16.039,16.039,0,0,0,241.88037,110.64453ZM93.333,64l27.7334,20.7998A16.10323,16.10323,0,0,0,130.667,88H200v16H69.76611a15.98037,15.98037,0,0,0-15.1792,10.94043L40,158.70166V64Z`;

        const makeSvg = (fill: string) => `<?xml version="1.0" encoding="UTF-8"?>` +
            `<svg xmlns='http://www.w3.org/2000/svg' width='${width}' height='${height}' viewBox='0 0 ${width} ${height}'>` +
            `<g transform='translate(${tx},0)'><g transform='scale(${scale})'>` +
            `<path fill='${fill}' d='${pathD}'/></g></g></svg>`;

        // read configuration for customized fills (allow users to set hex colors)
        const cfg = vscode.workspace.getConfiguration('rms_log_outline');
        const cfgLight = cfg.get<string>('folderIconLight');
        const cfgDark = cfg.get<string>('folderIconDark');
        const lightFill = cfgLight ?? '#2100f4';
        const darkFill = cfgDark ?? '#ffcc00';
        const light = vscode.Uri.parse('data:image/svg+xml;utf8,' + encodeURIComponent(makeSvg(lightFill)));
        const dark = vscode.Uri.parse('data:image/svg+xml;utf8,' + encodeURIComponent(makeSvg(darkFill)));
        return { light, dark };
    }
    
    constructor(public readonly block: JobBlock, private readonly extensionUri?: vscode.Uri) {
        const label = block.title || `Block (level ${block.level ?? 'N/A'})`;
        // start as non-collapsible; buildHierarchy will set Collapsed when children are added
        super(label, vscode.TreeItemCollapsibleState.None);
        this.description = (typeof block.elapsed === 'number') ? formatSeconds(block.elapsed) : (block.elapsed ? String(block.elapsed) : '');
        this.tooltip = `Level: ${block.level ?? 'N/A'} — Line: ${block.titleLine ?? 'N/A'}`;
        this.tooltip = `${block.title} - ${(typeof block.elapsed === 'number') ? formatSeconds(block.elapsed) : (block.elapsed ?? '')}`;
        this.command = {
            command: 'rms-log-outline.revealBlock',
            title: 'Reveal Block',
            arguments: [block]
        };
        // set an icon based on title patterns
        const t = (block.title || '').trim();
        try {
            // Use ThemeIcon with semantic ThemeColor so icons adapt to themes without SVGs
            if (/^Note\b/i.test(t)) {
                this.iconPath = new vscode.ThemeIcon('note', new vscode.ThemeColor('charts.yellow'));
            } else if (/skipped$/i.test(t)) {
                this.iconPath = new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('charts.blue'));
            } else if (/deactivated$/i.test(t)) {
                this.iconPath = new vscode.ThemeIcon('debug-stop', new vscode.ThemeColor('charts.orange'));
            } else {
                this.iconPath = new vscode.ThemeIcon('symbol-event');
            }
        } catch (e) {
            this.iconPath = new vscode.ThemeIcon('symbol-event');
        }
        this.contextValue = 'JobBlock';
    }
}

class JobBlocksProvider implements vscode.TreeDataProvider<JobBlockNode> {
    private _onDidChangeTreeData: vscode.EventEmitter<JobBlockNode | undefined | void> = new vscode.EventEmitter<JobBlockNode | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<JobBlockNode | undefined | void> = this._onDidChangeTreeData.event;
    constructor(private readonly context?: vscode.ExtensionContext) {}
    private treeView?: vscode.TreeView<JobBlockNode>;
    private lastRoots: JobBlockNode[] = [];
    private webview?: vscode.Webview;
    private activeCustomDocument?: vscode.TextDocument;

    attachTreeView(tv: vscode.TreeView<JobBlockNode>) { this.treeView = tv; }

    // Attach a webview to allow sending highlight messages
    attachWebview(webview: vscode.Webview) { this.webview = webview; }
    detachWebview() { this.webview = undefined; }

    setActiveCustomDocument(doc: vscode.TextDocument | undefined) {
        this.activeCustomDocument = doc;
        this.refresh();
    }

    removeActiveCustomDocument(doc: vscode.TextDocument) {
        if (this.activeCustomDocument && this.activeCustomDocument.uri.toString() === doc.uri.toString()) {
            this.activeCustomDocument = undefined;
            this.refresh();
        }
    }

    // Reveal a node by matching a document range (start/end)
    async revealRangeInTree(start: number, end: number) {
        // flatten lastRoots to search for node with matching start/end
        const all: JobBlockNode[] = [];
        function collect(nodes: JobBlockNode[]) {
            for (const n of nodes) {
                all.push(n);
                if (n.children.length) { collect(n.children); }
            }
        }
        collect(this.lastRoots);
        const match = all.find(n => n.block.start === start && n.block.end === end);
        if (match && this.treeView) {
            await this.treeView.reveal(match, { select: true, focus: true, expand: true });
        }
    }

    // Reveal a node by its title line number if available
    async revealByLine(line: number) {
        const all: JobBlockNode[] = [];
        function collect(nodes: JobBlockNode[]) {
            for (const n of nodes) {
                all.push(n);
                if (n.children.length) {
                    collect(n.children);
                }
            }
        }
        collect(this.lastRoots);
        const match = all.find(n => n.block.titleLine === line);
        if (match && this.treeView) {
            await this.treeView.reveal(match, { select: true, focus: true, expand: true });
        }
    }

    postHighlightToWebview(start: number, end: number, titleLine?: number) {
        try {
            if (this.webview) {
                const msg: any = { command: 'highlight', start, end };
                if (typeof titleLine === 'number') { msg.titleLine = titleLine; }
                this.webview.postMessage(msg);
            }
        } catch (e) {
            // ignore
        }
    }

    refresh(): void { this._onDidChangeTreeData.fire(); }

    getTreeItem(element: JobBlockNode): vscode.TreeItem | Thenable<vscode.TreeItem> { return element; }

    getParent(element: JobBlockNode): JobBlockNode | null {
        const findParent = (nodes: JobBlockNode[], target: JobBlockNode): JobBlockNode | null => {
            for (const n of nodes) {
                if (n.children && n.children.includes(target)) { return n; }
                const p = findParent(n.children, target);
                if (p) { return p; }
            }
            return null;
        };
        return findParent(this.lastRoots, element);
    }

    private buildHierarchy(blocks: JobBlock[]): JobBlockNode[] {
        const roots: JobBlockNode[] = [];
        const stack: JobBlockNode[] = [];

        for (const b of blocks) {
            const node = new JobBlockNode(b, this.context?.extensionUri);
            const lvl = b.level === null ? -1 : b.level;

            while (stack.length > 0) {
                const top = stack[stack.length - 1];
                const topLvl = top.block.level === null ? -1 : top.block.level;
                if (topLvl < lvl) { break; }
                stack.pop();
            }

            if (stack.length === 0) {
                roots.push(node);
            } else {
                const parent = stack[stack.length - 1];
                parent.children.push(node);
                // ensure parent is marked collapsible now that it has children
                parent.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
                // set folder icon for parent node (theme-aware SVG)
                const pIndent = (typeof parent.block.level === 'number' && parent.block.level !== null) ? Math.max(0, parent.block.level) : 0;
                parent.iconPath = JobBlockNode.makeFolderIcon(Math.min(pIndent * 6, 12));
            }

            stack.push(node);
        }

        // Group top-level roots by realization number
        const groups = new Map<string | number, JobBlockNode[]>();
        for (const r of roots) {
            const key = (typeof r.block.realization === 'number' && r.block.realization !== null) ? r.block.realization : 'unassigned';
            if (!groups.has(key)) { groups.set(key, []); }
            groups.get(key)!.push(r);
        }

        // Create a parent node per realization group
        const realizationParents: JobBlockNode[] = [];
        for (const [key, nodes] of groups) {
            const isUnassigned = key === 'unassigned';
            const title = isUnassigned ? 'Unassigned' : `Realization ${key}`;
            const aggBlock: JobBlock = {
                level: null,
                title,
                content: '',
                start: nodes.length ? nodes[0].block.start : 0,
                end: nodes.length ? nodes[nodes.length-1].block.end : 0,
                elapsed: null,
                titleLine: 1,
                realization: (isUnassigned ? null : (key as number))
            };
            const parentNode = new JobBlockNode(aggBlock, this.context?.extensionUri);
            parentNode.children = nodes;
            parentNode.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
            parentNode.iconPath = JobBlockNode.makeFolderIcon(0);
            realizationParents.push(parentNode);
        }

        function sumChildElapsed(node: JobBlockNode): number | null {
            if (!node.children || node.children.length === 0) {
                return (typeof node.block.elapsed === 'number') ? node.block.elapsed : null;
            }
            let childrenTotal = 0;
            let anyChild = false;
            for (const ch of node.children) {
                const chSum = sumChildElapsed(ch);
                if (typeof chSum === 'number') { childrenTotal += chSum; anyChild = true; }
            }
            if (anyChild) {
                const parentOwn = (typeof node.block.elapsed === 'number') ? node.block.elapsed : 0;
                const combined = parentOwn + childrenTotal;
                node.block.elapsed = combined;
                return combined;
            }
            return (typeof node.block.elapsed === 'number') ? node.block.elapsed : null;
        }

        for (const p of realizationParents) { sumChildElapsed(p); }

        function updateDisplay(node: JobBlockNode) {
            node.description = (typeof node.block.elapsed === 'number') ? formatSeconds(node.block.elapsed) : '';
            node.tooltip = `${node.block.title} - ${(typeof node.block.elapsed === 'number') ? formatSeconds(node.block.elapsed) : ''}`;
            if (node.children && node.children.length > 0) {
                for (const ch of node.children) { updateDisplay(ch); }
            }
        }
        for (const p of realizationParents) { updateDisplay(p); }

        this.lastRoots = realizationParents;
        return this.lastRoots;
    }

    async getChildren(element?: JobBlockNode): Promise<JobBlockNode[]> {
        let text = '';
        let docName = '';
        
        if (this.activeCustomDocument) {
             text = this.activeCustomDocument.getText();
             docName = require('path').basename(this.activeCustomDocument.fileName);
        } else {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                // Show a message in the tree view (faded text block) when no editor is open
                try { if (this.treeView) { this.treeView.message = 'The active editor cannot provide outline information.'; } } catch (e) {}
                return [];
            }
            text = editor.document.getText();
            docName = require('path').basename(editor.document.fileName);
        }

        const blocks = parseJobBlocks(loadAndPreprocess(text), text);
        if (!element) {
            if (!blocks || blocks.length === 0) {
                // Display the where/why message like the Outline view
                try {
                    if (this.treeView) {
                        this.treeView.message = `No RMS job blocks found in '${docName}'.`;
                    }
                } catch (e) {}
                return [];
            }
            // Clear any previous message and build hierarchical nodes
            try { if (this.treeView) { this.treeView.message = ''; } } catch (e) {}
            return this.buildHierarchy(blocks);
        }

        return element.children;
    }

    // Search for nodes matching a query (in title or content) and reveal the best match
    async searchAndReveal(query: string) {
        let text = '';
        if (this.activeCustomDocument) {
             text = this.activeCustomDocument.getText();
        } else {
            const editor = vscode.window.activeTextEditor;
            if (!editor) { vscode.window.showInformationMessage('No active editor'); return; }
            text = editor.document.getText();
        }

        // Ensure we have up-to-date nodes
        const blocks = parseJobBlocks(loadAndPreprocess(text), text);
        const roots = this.buildHierarchy(blocks);

        const all: JobBlockNode[] = [];
        function collect(nodes: JobBlockNode[]) {
            for (const n of nodes) {
                all.push(n);
                if (n.children.length) { collect(n.children); }
            }
        }
        collect(roots);

        const q = query.toLowerCase();
        const matches = all.filter(n => (n.block.title && n.block.title.toLowerCase().includes(q)));
        if (matches.length === 0) { vscode.window.showInformationMessage('No matches'); return; }
        if (matches.length === 1) { await this.revealRangeInTree(matches[0].block.start, matches[0].block.end); return; }
        // multiple matches -> QuickPick with title + snippet
        const items = matches.map(m => ({ label: m.block.title || '(no title)', description: (typeof m.block.elapsed === 'number') ? formatSeconds(m.block.elapsed) : undefined, node: m }));
        const pick = await vscode.window.showQuickPick(items, { placeHolder: `Found ${matches.length} matches` });
        if (pick && pick.node) { await this.revealRangeInTree(pick.node.block.start, pick.node.block.end); }
    }
}

// This method is called when your extension is deactivated
export function deactivate() {}

class RmsLogEditorProvider implements vscode.CustomTextEditorProvider {

    public static register(context: vscode.ExtensionContext, jobBlocksProvider: JobBlocksProvider): vscode.Disposable {
        const provider = new RmsLogEditorProvider(context, jobBlocksProvider);
        const providerRegistration = vscode.window.registerCustomEditorProvider(RmsLogEditorProvider.viewType, provider);
        return providerRegistration;
    }

    private static readonly viewType = 'rms-log-outline.logEditor';

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly jobBlocksProvider: JobBlocksProvider
    ) { }

    public async resolveCustomTextEditor(
        document: vscode.TextDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        webviewPanel.webview.options = {
            enableScripts: true,
        };

        function updateWebview() {
            webviewPanel.webview.html = getHtmlForWebview(document);
        }

        const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document.uri.toString() === document.uri.toString()) {
                updateWebview();
            }
        });

        webviewPanel.onDidDispose(() => {
            changeDocumentSubscription.dispose();
            this.jobBlocksProvider.removeActiveCustomDocument(document);
        });
        
        // When the panel becomes active, attach it to the provider for highlighting
        webviewPanel.onDidChangeViewState(e => {
            if (e.webviewPanel.active) {
                this.jobBlocksProvider.attachWebview(webviewPanel.webview);
                this.jobBlocksProvider.setActiveCustomDocument(document);
            }
        });
        
        if (webviewPanel.active) {
            this.jobBlocksProvider.attachWebview(webviewPanel.webview);
            this.jobBlocksProvider.setActiveCustomDocument(document);
        }

        updateWebview();
    }
}

function getHtmlForWebview(document: vscode.TextDocument): string {
    const text = document.getText();
    // Use the existing preprocessing logic
    let content = loadAndPreprocess(text);
    
    // Inject IDs for navigation
    // We need two sets of blocks:
    // 1. blocksOriginal: offsets relative to 'text' (original document), which match the Tree View IDs.
    // 2. blocksContent: offsets relative to 'content' (preprocessed HTML), which match where we inject IDs.
    const blocksOriginal = parseJobBlocks(content, text);
    const blocksContent = parseJobBlocks(content);

    // Create injection list by zipping them
    // blocksOriginal[i] corresponds to blocksContent[i]
    const injections = blocksContent.map((b, i) => ({
        offset: b.start,
        id: blocksOriginal[i].start
    }));
    
    // Sort descending by offset to inject safely
    injections.sort((a, b) => b.offset - a.offset);
    
    for (const item of injections) {
        // We expect a <pre> tag at item.offset. 
        if (content.substring(item.offset, item.offset + 4).toLowerCase() === '<pre') {
            content = content.slice(0, item.offset + 4) + ` id="b_${item.id}"` + content.slice(item.offset + 4);
        }
    }

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>RMS Log</title>
    <style>
        body { 
            font-family: var(--vscode-editor-font-family); 
            font-size: var(--vscode-editor-font-size);
            color: var(--vscode-editor-foreground);
            background-color: var(--vscode-editor-background);
            padding: 10px;
        }
        pre {
            white-space: pre-wrap;
        }
    </style>
</head>
<body>
    ${content}
    <script>
        const vscode = acquireVsCodeApi();
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.command) {
                case 'highlight':
                    const el = document.getElementById('b_' + message.start);
                    if (el) {
                        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                        
                        // Visual highlight
                        el.style.outline = '2px solid var(--vscode-editor-selectionBackground)';
                        setTimeout(() => { el.style.outline = ''; }, 2000);

                        // Select the header text (first non-empty line)
                        const selection = window.getSelection();
                        selection.removeAllRanges();
                        const range = document.createRange();
                        
                        let textNode = null;
                        // Find first text node
                        for (let i = 0; i < el.childNodes.length; i++) {
                            if (el.childNodes[i].nodeType === 3) {
                                textNode = el.childNodes[i];
                                break;
                            }
                        }
                        
                        if (textNode) {
                            const text = textNode.textContent;
                            let start = 0;
                            while (start < text.length) {
                                const end = text.indexOf('\\n', start);
                                const lineEnd = end === -1 ? text.length : end;
                                const line = text.substring(start, lineEnd);
                                if (line.trim().length > 0) {
                                    range.setStart(textNode, start);
                                    range.setEnd(textNode, lineEnd);
                                    selection.addRange(range);
                                    break;
                                }
                                start = lineEnd + 1;
                            }
                        } else {
                            // Fallback: select element
                            range.selectNode(el);
                            selection.addRange(range);
                        }
                    }
                    break;
            }
        });
    </script>
</body>
</html>`;
}

