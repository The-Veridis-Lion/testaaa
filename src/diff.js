import { extensionName, getAppContext, runtimeState } from './state.js';
import { getCurrentCharacterContext } from './utils.js';
import { applyReplacements } from './core.js';

function emitDiffEvent(eventName, detail = {}) {
    try {
        document.dispatchEvent(new CustomEvent(eventName, { detail }));
    } catch (e) { }
}

function hasRenderableDiff(cacheData) {
    return !!(
        cacheData
        && ((Array.isArray(cacheData.snippets) && cacheData.snippets.length > 0)
            || String(cacheData.fullDiff || '') !== '')
    );
}

function getChatRoot() {
    return document.querySelector('#chat');
}

function getMessageNodes() {
    const chat = getChatRoot();
    if (!chat) return [];
    return Array.from(chat.querySelectorAll('.mes')).filter((el) => !el.closest('.mes[is_hidden="true"]'));
}

function getMessageIndexFromNode(node) {
    if (!node) return -1;

    const direct =
        node.getAttribute?.('mesid')
        ?? node.dataset?.mesid
        ?? node.dataset?.messageId
        ?? node.dataset?.messageid
        ?? node.getAttribute?.('data-mesid')
        ?? node.getAttribute?.('data-message-id');

    if (direct != null && direct !== '' && !Number.isNaN(Number(direct))) {
        return Number(direct);
    }

    const nodes = getMessageNodes();
    return nodes.indexOf(node);
}

function getMessageNodeByIndex(index) {
    const nodes = getMessageNodes();
    if (index < 0 || index >= nodes.length) return null;
    return nodes[index] || null;
}

function getActionBar(node) {
    if (!node) return null;
    return (
        node.querySelector('.mes_buttons')
        || node.querySelector('.mes_block .flex-container')
        || node.querySelector('.mes_block')
        || node
    );
}

function makeDiffButton(index) {
    const btn = document.createElement('div');
    btn.className = 'mes_button bl-diff-btn bl-diff-btn-top fa-solid fa-clock-rotate-left interactable';
    btn.title = '溯源净化前文';
    btn.setAttribute('data-index', String(index));
    btn.setAttribute('tabindex', '0');
    btn.setAttribute('role', 'button');
    return btn;
}

function getLatestThreeStorageKey() {
    try {
        const { chat_metadata } = getAppContext();
        const context = getCurrentCharacterContext();
        const charKey = String(context?.key || 'unknown').trim() || 'unknown';
        const chatKey = String(
            chat_metadata?.main_chat
            || chat_metadata?.chat_id
            || chat_metadata?.file_name
            || chat_metadata?.create_date
            || window.location?.hash
            || 'default'
        ).trim() || 'default';
        return `th_keyword_filter_latest3::${charKey}::${chatKey}`;
    } catch (e) {
        return '';
    }
}

function persistLatestThreeSnapshot() {
    try {
        const key = getLatestThreeStorageKey();
        if (!key) return;
        const latest = Array.isArray(runtimeState.latestDiffMessageIndices) ? runtimeState.latestDiffMessageIndices.slice(-3) : [];
        const ready = {};
        const cache = {};
        latest.forEach((index) => {
            ready[index] = runtimeState.diffReadyState.get(index) === true;
            const cached = runtimeState.diffSnippetsCache.get(index);
            if (cached && typeof cached === 'object') {
                cache[index] = {
                    snippets: Array.isArray(cached.snippets) ? cached.snippets : [],
                    fullDiff: String(cached.fullDiff || ''),
                };
            }
        });
        localStorage.setItem(key, JSON.stringify({ latestThree: latest, ready, cache }));
    } catch (e) { }
}

function pruneStateToLatestThree() {
    const latest = new Set(runtimeState.latestDiffMessageIndices || []);
    Array.from(runtimeState.diffSnippetsCache.keys()).forEach((index) => {
        if (!latest.has(index)) runtimeState.diffSnippetsCache.delete(index);
    });
    Array.from(runtimeState.diffReadyState.keys()).forEach((index) => {
        if (!latest.has(index)) runtimeState.diffReadyState.delete(index);
    });
}

function setLatestThreeIndices(indices) {
    const normalized = Array.from(new Set((indices || []).filter((i) => Number.isInteger(i) && i >= 0))).sort((a, b) => a - b).slice(-3);
    runtimeState.latestDiffMessageIndices = normalized;
    pruneStateToLatestThree();
    persistLatestThreeSnapshot();
}

function getLatestThreeFromNewestIndex(newestIndex) {
    if (!Number.isInteger(newestIndex) || newestIndex < 0) return [];
    const start = Math.max(0, newestIndex - 2);
    const list = [];
    for (let i = start; i <= newestIndex; i++) list.push(i);
    return list;
}

export function syncLatestThreeButtonsByNewestIndex(newestIndex) {
    const nodes = getMessageNodes();
    if (!nodes.length) return;

    const latest = getLatestThreeFromNewestIndex(newestIndex);
    setLatestThreeIndices(latest);
    const latestSet = new Set(latest);

    for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        if (latestSet.has(i)) {
            ensureMessageDiffButton(i, node);
        } else {
            removeDiffButtonForIndex(i, node);
        }
    }
}

export function syncLatestThreeButtonsByMessageNode(messageNode) {
    const index = getMessageIndexFromNode(messageNode);
    if (index < 0) return;
    syncLatestThreeButtonsByNewestIndex(index);
}

export function syncLatestThreeButtonsFromDOM() {
    const nodes = getMessageNodes();
    if (!nodes.length) {
        setLatestThreeIndices([]);
        return;
    }
    syncLatestThreeButtonsByNewestIndex(nodes.length - 1);
}

export function restoreLatestThreeSnapshot() {
    try {
        const key = getLatestThreeStorageKey();
        if (!key) return;
        const raw = localStorage.getItem(key);
        if (!raw) return;
        const data = JSON.parse(raw);
        const latestThree = Array.isArray(data?.latestThree) ? data.latestThree.filter((i) => Number.isInteger(i) && i >= 0).slice(-3) : [];
        runtimeState.latestDiffMessageIndices = latestThree;
        runtimeState.diffReadyState.clear();
        runtimeState.diffSnippetsCache.clear();
        latestThree.forEach((index) => {
            runtimeState.diffReadyState.set(index, data?.ready?.[index] === true);
            const cached = data?.cache?.[index];
            if (cached && typeof cached === 'object') {
                runtimeState.diffSnippetsCache.set(index, {
                    snippets: Array.isArray(cached.snippets) ? cached.snippets : [],
                    fullDiff: String(cached.fullDiff || ''),
                });
            }
        });
        emitDiffEvent('bl-diff-cache-updated', { index: -1 });
    } catch (e) { }
}

function removeDiffButtonForIndex(index, node = null) {
    const targetNode = node || getMessageNodeByIndex(index);
    if (!targetNode) return;
    targetNode.querySelectorAll(`.bl-diff-btn[data-index="${index}"]`).forEach((el) => el.remove());
}

/**
 * 将原始文本进行 HTML 转义，避免差异片段注入标签。
 * @param {string} [value=''] 需要转义的文本。
 * @returns {string} 已转义的安全 HTML 文本。
 */
export function escapeHtml(value = '') {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * 生成两段文本的行内差异 HTML。
 *
 * 算法说明：
 * - 先通过动态规划求出 oldStr/newStr 的最长公共子序列（LCS）长度矩阵；
 * - 再从矩阵右下角回溯，公共字符保持原样，新增字符包裹在 <ins>，删除字符包裹在 <del>；
 * - 最后合并连续同类标签，得到可读性更高的高亮结果。
 * @param {string} oldStr 原始文本。
 * @param {string} newStr 净化后文本。
 * @returns {string} 包含 <ins>/<del> 标记的差异 HTML。
 */
export function getInlineDiff(oldStr, newStr) {
    if (oldStr === newStr) return escapeHtml(oldStr);
    if (!oldStr && !newStr) return "";

    const oldChars = Array.from(oldStr);
    const newChars = Array.from(newStr);
    const m = oldChars.length;
    const n = newChars.length;

    const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));

    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (oldChars[i - 1] === newChars[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }

    let i = m;
    let j = n;
    const diff = [];
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && oldChars[i - 1] === newChars[j - 1]) {
            diff.push(escapeHtml(oldChars[i - 1]));
            i--;
            j--;
        } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            diff.push(`<ins>${escapeHtml(newChars[j - 1])}</ins>`);
            j--;
        } else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
            diff.push(`<del>${escapeHtml(oldChars[i - 1])}</del>`);
            i--;
        }
    }

    return diff.reverse().join('')
        .replace(/<\/ins><ins>/g, '')
        .replace(/<\/del><del>/g, '');
}

/**
 * 从原始消息文本中构建净化结果与可视化差异缓存。
 *
 * 解析逻辑：
 * - Snippet 模式：按行比较原文与净化结果，仅收集发生变化的行，生成紧凑差异片段；
 * - Full Text 模式：优先抽取 <content>...</content> 主体，再逐行生成完整对照（含未修改行）。
 * @param {string} rawText 原始消息文本。
 * @returns {{cleanedText: string, snippets: string[], fullDiff: string}} 净化文本、片段差异和全文差异。
 */
export function buildDiffSnippetsFromText(rawText) {
    if (typeof rawText !== 'string') return { cleanedText: rawText, snippets: [], fullDiff: "" };
    const parts = rawText.split('\n');
    const cleanedParts = new Array(parts.length);
    const snippets = [];

    for (let i = 0; i < parts.length; i++) {
        const originalPart = parts[i];
        const cleanedPart = applyReplacements(originalPart);
        cleanedParts[i] = cleanedPart;

        if (cleanedPart !== originalPart) {
            const inlineDiffHTML = getInlineDiff(originalPart, cleanedPart);
            snippets.push(`<div class="bl-diff-snippet">${inlineDiffHTML}</div>`);
        }
    }

    const cleanedText = cleanedParts.join('\n');

    let targetText = rawText;
    const contentMatch = rawText.match(/<content>([\s\S]*?)<\/content>/i);
    if (contentMatch) targetText = contentMatch[1].trim();

    const fullParts = targetText.split('\n');
    const fullDiffBlocks = [];

    for (let i = 0; i < fullParts.length; i++) {
        const originalPart = fullParts[i].trim();
        if (!originalPart) continue;

        const cleanedPart = applyReplacements(originalPart);
        if (cleanedPart !== originalPart) {
            const inlineDiffHTML = getInlineDiff(originalPart, cleanedPart);
            fullDiffBlocks.push(`<div class="bl-diff-full-modified">${inlineDiffHTML}</div>`);
        } else {
            fullDiffBlocks.push(`<div class="bl-diff-full-normal">${escapeHtml(originalPart)}</div>`);
        }
    }

    const fullDiff = fullDiffBlocks.join('');

    return {
        cleanedText,
        snippets,
        fullDiff,
    };
}

export function setDiffReadyState(index, ready) {
    if (!Number.isInteger(index) || index < 0) return;
    runtimeState.diffReadyState.set(index, ready === true);
    emitDiffEvent('bl-diff-ready-state', { index, ready: ready === true });
    persistLatestThreeSnapshot();
}

export function isDiffReady(index) {
    return runtimeState.diffReadyState.get(index) === true;
}

/**
 * 更新指定消息的差异缓存。
 * @param {number} index 消息索引。
 * @param {{snippets?: string[], fullDiff?: string}} cacheData 差异缓存数据。
 * @returns {void}
 */
export function updateDiffSnippetCache(index, cacheData) {
    if (!Number.isInteger(index) || index < 0) return;
    if (!cacheData || !hasRenderableDiff(cacheData)) {
        runtimeState.diffSnippetsCache.delete(index);
    } else {
        runtimeState.diffSnippetsCache.set(index, {
            snippets: Array.isArray(cacheData.snippets) ? cacheData.snippets : [],
            fullDiff: String(cacheData.fullDiff || ''),
        });
    }
    emitDiffEvent('bl-diff-cache-updated', { index });
    persistLatestThreeSnapshot();
}

/**
 * 确保消息节点拥有正确的“净化前文溯源”按钮状态。
 * 这里只负责最新三条常驻按钮，不再以是否已有 diff cache 为前置条件。
 * @param {number} index 消息索引。
 * @param {Element} messageNode 消息 DOM 节点。
 * @returns {void}
 */
export function ensureMessageDiffButton(index, messageNode) {
    if (!messageNode || !Number.isInteger(index) || index < 0) return;

    const { extension_settings } = getAppContext();
    const isEnabled = extension_settings[extensionName]?.enableVisualDiff !== false;
    const latestSet = new Set(runtimeState.latestDiffMessageIndices || []);
    const shouldShow = isEnabled && latestSet.has(index);

    const buttonArea = getActionBar(messageNode);
    if (!buttonArea) return;

    let existing = messageNode.querySelector(`.bl-diff-btn[data-index="${index}"]`);

    if (!shouldShow) {
        if (existing) existing.remove();
        return;
    }

    if (!existing) {
        const button = makeDiffButton(index);
        const editBtn = buttonArea.querySelector('.mes_edit');
        if (editBtn) buttonArea.insertBefore(button, editBtn);
        else buttonArea.appendChild(button);
        existing = button;
    }

    existing.setAttribute('data-index', String(index));
}

/**
 * 扫描当前聊天区域并按最新三条消息注入差异按钮。
 * @returns {void}
 */
export function injectDiffButtons() {
    syncLatestThreeButtonsFromDOM();
}

/**
 * 获取指定消息的差异缓存数据。
 * @param {number} index 消息索引。
 * @returns {{snippets: string[], fullDiff: string}} 对应消息的差异片段与全文差异。
 */
export function getDiffSnippetsForMessage(index) {
    const cached = runtimeState.diffSnippetsCache.get(index);
    if (!cached || typeof cached !== 'object') return { snippets: [], fullDiff: '' };
    return {
        snippets: Array.isArray(cached.snippets) ? cached.snippets : [],
        fullDiff: String(cached.fullDiff || ''),
    };
}

/**
 * 清空全部消息差异缓存。
 * @returns {void}
 */
export function clearDiffSnippetsCache() {
    runtimeState.diffSnippetsCache.clear();
    runtimeState.diffReadyState.clear();
    emitDiffEvent('bl-diff-cache-updated', { index: -1 });
}
