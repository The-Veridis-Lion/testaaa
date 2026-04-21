import { extensionName, getAppContext, runtimeState } from './state.js';
import { getCurrentCharacterContext } from './utils.js';
import { applyReplacements } from './core.js';

const DIFF_STORAGE_PREFIX = `${extensionName}:latest_diff_cache:v2`;
const DIFF_STORAGE_SCOPES_KEY = `${DIFF_STORAGE_PREFIX}:scopes`;
const MAX_PERSISTED_SCOPES = 6;
const MAX_TRACKED_DIFF_MESSAGES = 3;

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
 * 对文本构建稳定签名，用于刷新后校验最新 3 条缓存是否仍对应当前消息。
 * @param {string} [text=''] 文本。
 * @returns {string} 文本签名。
 */
export function buildDiffTextSignature(text = '') {
    const source = String(text || '');
    let hash = 0;
    for (let i = 0; i < source.length; i++) {
        hash = ((hash << 5) - hash) + source.charCodeAt(i);
        hash |= 0;
    }
    return `${source.length}:${Math.abs(hash)}`;
}

function getDiffStorageKey(scopeKey) {
    return `${DIFF_STORAGE_PREFIX}:${scopeKey}`;
}

function dispatchDiffStateEvent(index, reason = 'updated') {
    document.dispatchEvent(new CustomEvent('bl-diff-state-updated', {
        detail: { index, reason }
    }));
}

function normalizeEntry(index, entry = {}) {
    return {
        index,
        status: entry.status === 'loading' ? 'loading' : 'ready',
        rawText: typeof entry.rawText === 'string' ? entry.rawText : '',
        cleanedText: typeof entry.cleanedText === 'string' ? entry.cleanedText : '',
        signature: typeof entry.signature === 'string' ? entry.signature : '',
        snippets: Array.isArray(entry.snippets) ? entry.snippets : [],
        fullDiff: typeof entry.fullDiff === 'string' ? entry.fullDiff : '',
        updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : Date.now(),
    };
}

function getCurrentMessageText(index) {
    const { chat } = getAppContext();
    if (!Array.isArray(chat) || index < 0 || index >= chat.length) return '';
    const msg = chat[index];
    if (!msg || typeof msg !== 'object') return '';
    return typeof msg.mes === 'string' ? msg.mes : '';
}

/**
 * 获取当前聊天对应的差异缓存作用域键。
 * 作用域限定为“当前角色 + 当前聊天”。
 * @returns {string} 当前聊天作用域键。
 */
export function getCurrentDiffScopeKey() {
    const { chat_metadata } = getAppContext();
    const character = getCurrentCharacterContext();
    const chatId = String(
        chat_metadata?.main_chat
        || chat_metadata?.chat_id
        || chat_metadata?.session_id
        || chat_metadata?.conversation_id
        || chat_metadata?.file_name
        || window.location?.hash
        || 'chat'
    ).trim();
    const characterKey = String(character?.key || 'unknown-character').trim();
    return `${characterKey}::${chatId || 'chat'}`;
}

function writeScopeRegistry(scopeKey) {
    try {
        const parsed = JSON.parse(localStorage.getItem(DIFF_STORAGE_SCOPES_KEY) || '[]');
        const list = Array.isArray(parsed) ? parsed.filter(Boolean) : [];
        const next = [scopeKey, ...list.filter(v => v !== scopeKey)].slice(0, MAX_PERSISTED_SCOPES);
        localStorage.setItem(DIFF_STORAGE_SCOPES_KEY, JSON.stringify(next));

        for (const staleScope of list) {
            if (!next.includes(staleScope)) {
                localStorage.removeItem(getDiffStorageKey(staleScope));
            }
        }
    } catch (e) { }
}

/**
 * 持久化当前聊天的最新 3 条对比状态。
 * @returns {void}
 */
export function persistLatestDiffStateForCurrentChat() {
    const scopeKey = runtimeState.currentDiffScopeKey || getCurrentDiffScopeKey();
    runtimeState.currentDiffScopeKey = scopeKey;

    const entries = runtimeState.latestDiffMessageIndices
        .filter((index) => Number.isInteger(index) && index >= 0)
        .map((index) => normalizeEntry(index, runtimeState.diffMessageState.get(index) || runtimeState.diffSnippetsCache.get(index) || {}));

    try {
        localStorage.setItem(getDiffStorageKey(scopeKey), JSON.stringify({
            scopeKey,
            savedAt: Date.now(),
            entries,
        }));
        writeScopeRegistry(scopeKey);
    } catch (e) {
        console.warn('[Ultimate Purifier] 最新 3 条差异缓存持久化失败', e);
    }
}

function removeTrackedEntry(index, reason = 'removed') {
    runtimeState.diffMessageState.delete(index);
    runtimeState.diffSnippetsCache.delete(index);
    runtimeState.latestDiffMessageIndices = runtimeState.latestDiffMessageIndices.filter((value) => value !== index);
    dispatchDiffStateEvent(index, reason);
}

function trimTrackedQueue() {
    while (runtimeState.latestDiffMessageIndices.length > MAX_TRACKED_DIFF_MESSAGES) {
        const removed = runtimeState.latestDiffMessageIndices.shift();
        if (Number.isInteger(removed) && removed >= 0) removeTrackedEntry(removed, 'evicted');
    }
}

/**
 * 判断消息索引是否属于当前聊天最新 3 条对比队列。
 * @param {number} index 消息索引。
 * @returns {boolean} 是否被跟踪。
 */
export function isTrackedLatestDiffIndex(index) {
    return runtimeState.latestDiffMessageIndices.includes(index);
}

/**
 * 将指定消息纳入“当前聊天最新 3 条”队列，并自动淘汰最旧一条。
 * @param {number} index 消息索引。
 * @returns {void}
 */
export function trackLatestDiffIndex(index) {
    if (!Number.isInteger(index) || index < 0) return;
    runtimeState.currentDiffScopeKey = getCurrentDiffScopeKey();

    const before = runtimeState.latestDiffMessageIndices.join(',');
    runtimeState.latestDiffMessageIndices = runtimeState.latestDiffMessageIndices.filter((value) => value !== index);
    runtimeState.latestDiffMessageIndices.push(index);
    trimTrackedQueue();
    const after = runtimeState.latestDiffMessageIndices.join(',');

    if (before === after) return;
    persistLatestDiffStateForCurrentChat();
    dispatchDiffStateEvent(index, 'tracked');
}

/**
 * 将指定消息标记为 loading 状态。
 * @param {number} index 消息索引。
 * @returns {void}
 */
export function markTrackedDiffMessageLoading(index) {
    if (!Number.isInteger(index) || index < 0) return;
    trackLatestDiffIndex(index);
    const current = normalizeEntry(index, runtimeState.diffMessageState.get(index));
    const alreadyLatest = runtimeState.latestDiffMessageIndices[runtimeState.latestDiffMessageIndices.length - 1] === index;
    if (alreadyLatest && current.status === 'loading') return;

    const next = {
        ...current,
        status: 'loading',
        rawText: '',
        cleanedText: '',
        signature: '',
        snippets: [],
        fullDiff: '',
        updatedAt: Date.now(),
    };
    runtimeState.diffMessageState.set(index, next);
    runtimeState.diffSnippetsCache.set(index, next);
    persistLatestDiffStateForCurrentChat();
    dispatchDiffStateEvent(index, 'loading');
}

/**
 * 从本地持久化恢复当前聊天的最新 3 条对比状态。
 * 仅恢复仍能与当前聊天正文签名对上的 ready 项。
 * @returns {void}
 */
export function restoreLatestDiffStateForCurrentChat() {
    runtimeState.currentDiffScopeKey = getCurrentDiffScopeKey();
    runtimeState.diffMessageState.clear();
    runtimeState.diffSnippetsCache.clear();
    runtimeState.latestDiffMessageIndices = [];

    try {
        const raw = localStorage.getItem(getDiffStorageKey(runtimeState.currentDiffScopeKey));
        if (!raw) return;
        const parsed = JSON.parse(raw);
        const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
        for (const item of entries) {
            const index = Number(item?.index);
            if (!Number.isInteger(index) || index < 0) continue;

            const entry = normalizeEntry(index, item);
            if (entry.status === 'ready') {
                const currentText = getCurrentMessageText(index);
                if (!currentText) continue;
                const currentSignature = buildDiffTextSignature(currentText);
                if (!entry.signature || currentSignature !== entry.signature) continue;
            }

            runtimeState.latestDiffMessageIndices.push(index);
            runtimeState.diffMessageState.set(index, entry);
            runtimeState.diffSnippetsCache.set(index, entry);
        }
        trimTrackedQueue();
    } catch (e) {
        console.warn('[Ultimate Purifier] 恢复最新 3 条差异缓存失败', e);
    }
}

/**
 * 重置当前页面内存中的差异状态，不删除持久化记录。
 * @returns {void}
 */
export function resetLatestDiffRuntimeState() {
    runtimeState.diffSnippetsCache.clear();
    runtimeState.diffMessageState.clear();
    runtimeState.latestDiffMessageIndices = [];
    runtimeState.currentDiffIndex = undefined;
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

/**
 * 更新指定消息的差异缓存，并在缓存落盘后通知弹窗自动刷新。
 * @param {number} index 消息索引。
 * @param {{status?: string, snippets?: string[], fullDiff?: string, rawText?: string, cleanedText?: string, signature?: string}} cacheData 差异缓存数据。
 * @returns {void}
 */
export function updateDiffSnippetCache(index, cacheData) {
    if (!Number.isInteger(index) || index < 0) return;
    const tracked = isTrackedLatestDiffIndex(index);
    if (!tracked && !cacheData) return;

    const existing = normalizeEntry(index, runtimeState.diffMessageState.get(index) || runtimeState.diffSnippetsCache.get(index) || {});
    const next = normalizeEntry(index, {
        ...existing,
        ...cacheData,
        status: cacheData?.status || 'ready',
        updatedAt: Date.now(),
    });

    runtimeState.diffMessageState.set(index, next);
    runtimeState.diffSnippetsCache.set(index, next);
    persistLatestDiffStateForCurrentChat();
    dispatchDiffStateEvent(index, 'ready');
}

/**
 * 确保消息节点拥有正确的“净化前文溯源”按钮状态。
 * 仅对当前聊天最新 3 条消息显示按钮；loading 时也显示按钮。
 * @param {number} index 消息索引。
 * @param {Element} messageNode 消息 DOM 节点。
 * @returns {void}
 */
export function ensureMessageDiffButton(index, messageNode) {
    if (!messageNode || !Number.isInteger(index) || index < 0) return;

    const { extension_settings } = getAppContext();
    const isEnabled = extension_settings[extensionName]?.enableVisualDiff !== false;
    const isTopInExtra = extension_settings[extensionName]?.diffButtonInExtraMenu === true;
    const isTracked = isTrackedLatestDiffIndex(index);

    const buttonArea = messageNode.querySelector('.mes_buttons');
    if (buttonArea) {
        let existing = buttonArea.querySelector('.bl-diff-btn-top');
        const extraMenu = buttonArea.querySelector('.extraMesButtons');
        const targetContainer = (isTopInExtra && extraMenu) ? extraMenu : buttonArea;

        if (existing && existing.parentElement !== targetContainer) {
            existing.remove();
            existing = null;
        }

        if (!isEnabled || !isTracked) {
            if (existing) existing.remove();
        } else if (!existing) {
            const button = document.createElement('div');
            button.className = 'mes_button bl-diff-btn bl-diff-btn-top fa-solid fa-clock-rotate-left interactable';
            button.title = '溯源净化前文';
            button.setAttribute('data-index', String(index));
            button.setAttribute('tabindex', '0');
            button.setAttribute('role', 'button');

            if (isTopInExtra && extraMenu) {
                extraMenu.appendChild(button);
            } else {
                const editBtn = buttonArea.querySelector('.mes_edit');
                if (editBtn) buttonArea.insertBefore(button, editBtn);
                else buttonArea.appendChild(button);
            }
        } else {
            existing.setAttribute('data-index', String(index));
        }
    }

    const swipeBlock = messageNode.querySelector('.swipeRightBlock');
    if (swipeBlock) {
        const parent = swipeBlock.parentNode;
        const existingBottom = parent?.querySelector('.bl-diff-btn-bottom');

        if (!isEnabled || !isTracked) {
            if (existingBottom) existingBottom.remove();
        } else if (!existingBottom && parent) {
            const btnBottom = document.createElement('div');
            btnBottom.className = 'bl-diff-btn bl-diff-btn-bottom fa-solid fa-clock-rotate-left interactable';
            btnBottom.title = '溯源净化前文 (尾部触发)';
            btnBottom.setAttribute('data-index', String(index));
            btnBottom.setAttribute('tabindex', '0');
            btnBottom.setAttribute('role', 'button');
            parent.insertBefore(btnBottom, swipeBlock);
        } else if (existingBottom) {
            existingBottom.setAttribute('data-index', String(index));
        }
    }
}

/**
 * 扫描当前聊天区域并按消息索引注入差异按钮。
 * @returns {void}
 */
export function injectDiffButtons() {
    const chatEl = document.getElementById('chat');
    if (!chatEl) return;
    const messageNodes = chatEl.querySelectorAll('.mes');
    for (let i = 0; i < messageNodes.length; i++) {
        const node = messageNodes[i];
        const attrs = [node.getAttribute('mesid'), node.getAttribute('data-mesid'), node.getAttribute('messageid'), node.getAttribute('data-message-id')];
        let index = -1;
        for (const raw of attrs) {
            const n = Number(raw);
            if (Number.isInteger(n) && n >= 0) {
                index = n;
                break;
            }
        }
        if (index < 0) index = i;
        ensureMessageDiffButton(index, node);
    }
}

/**
 * 获取指定消息的差异缓存数据。
 * @param {number} index 消息索引。
 * @returns {{status: string, snippets: string[], fullDiff: string, rawText: string, cleanedText: string, signature: string}} 对应消息的差异缓存。
 */
export function getDiffSnippetsForMessage(index) {
    const cached = runtimeState.diffMessageState.get(index) || runtimeState.diffSnippetsCache.get(index);
    if (!cached || typeof cached !== 'object') {
        return { status: 'ready', snippets: [], fullDiff: '', rawText: '', cleanedText: '', signature: '' };
    }
    const entry = normalizeEntry(index, cached);
    return {
        status: entry.status,
        snippets: entry.snippets,
        fullDiff: entry.fullDiff,
        rawText: entry.rawText,
        cleanedText: entry.cleanedText,
        signature: entry.signature,
    };
}

/**
 * 清空全部消息差异缓存。
 * @returns {void}
 */
export function clearDiffSnippetsCache() {
    resetLatestDiffRuntimeState();
}
