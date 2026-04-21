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

function ensureLatest3ButtonHelper() {
    if (window.THKeywordFilterLatest3) return window.THKeywordFilterLatest3;

    window.THKeywordFilterLatest3 = (() => {
        const state = {
            latestThree: [],
            observer: null,
        };

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
                node.getAttribute?.('mesid') ??
                node.dataset?.mesid ??
                node.dataset?.messageId ??
                node.dataset?.messageid ??
                node.getAttribute?.('data-mesid') ??
                node.getAttribute?.('data-message-id');

            if (direct != null && direct !== '' && !Number.isNaN(Number(direct))) {
                return Number(direct);
            }

            const nodes = getMessageNodes();
            return nodes.indexOf(node);
        }

        function getMessageNodeByIndex(index) {
            const nodes = getMessageNodes();
            const byAttr = nodes.find((node) => getMessageIndexFromNode(node) === index);
            if (byAttr) return byAttr;
            if (index < 0 || index >= nodes.length) return null;
            return nodes[index] || null;
        }

        function getActionBar(node) {
            if (!node) return null;
            return (
                node.querySelector('.mes_buttons') ||
                node.querySelector('.mes_block .flex-container') ||
                node.querySelector('.mes_block') ||
                node
            );
        }

        function removeLegacyButtons(node) {
            if (!node) return;
            node.querySelectorAll('.bl-diff-btn-top, .bl-diff-btn-bottom').forEach((el) => el.remove());
        }

        function makeDiffButton(index) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'bl-diff-btn menu_button';
            btn.dataset.blDiffIndex = String(index);
            btn.dataset.index = String(index);
            btn.textContent = '对比';
            btn.title = '查看净化前文本对比';
            return btn;
        }

        function ensureDiffButtonForIndex(index) {
            const node = getMessageNodeByIndex(index);
            if (!node) return;

            removeLegacyButtons(node);

            const old = node.querySelector(`.bl-diff-btn[data-bl-diff-index="${index}"], .bl-diff-btn[data-index="${index}"]`);
            if (old) {
                old.dataset.blDiffIndex = String(index);
                old.dataset.index = String(index);
                return;
            }

            const bar = getActionBar(node);
            if (!bar) return;

            const btn = makeDiffButton(index);
            bar.appendChild(btn);
        }

        function removeDiffButtonForIndex(index) {
            const node = getMessageNodeByIndex(index);
            if (!node) return;

            removeLegacyButtons(node);
            node
                .querySelectorAll(`.bl-diff-btn[data-bl-diff-index="${index}"], .bl-diff-btn[data-index="${index}"]`)
                .forEach((el) => el.remove());
        }

        function setLatestThreeByNewestIndex(newestIndex) {
            if (!Number.isInteger(newestIndex) || newestIndex < 0) return [];

            const start = Math.max(0, newestIndex - 2);
            state.latestThree = [];
            for (let i = start; i <= newestIndex; i++) {
                state.latestThree.push(i);
            }
            return [...state.latestThree];
        }

        function syncLatestThreeButtonsByNewestIndex(newestIndex) {
            const nodes = getMessageNodes();
            if (!nodes.length) return;

            const latest = setLatestThreeByNewestIndex(newestIndex);
            const latestSet = new Set(latest);

            for (let i = 0; i < nodes.length; i++) {
                const node = nodes[i];
                const index = getMessageIndexFromNode(node);
                if (latestSet.has(index >= 0 ? index : i)) {
                    ensureDiffButtonForIndex(index >= 0 ? index : i);
                } else {
                    removeDiffButtonForIndex(index >= 0 ? index : i);
                }
            }
        }

        function syncLatestThreeButtonsByIndices(indices = []) {
            const nodes = getMessageNodes();
            if (!nodes.length) return;

            const cleaned = indices
                .map((value) => Number(value))
                .filter((value) => Number.isInteger(value) && value >= 0);
            state.latestThree = [...cleaned];
            const latestSet = new Set(cleaned);

            for (let i = 0; i < nodes.length; i++) {
                const node = nodes[i];
                const index = getMessageIndexFromNode(node);
                const resolved = index >= 0 ? index : i;
                if (latestSet.has(resolved)) {
                    ensureDiffButtonForIndex(resolved);
                } else {
                    removeDiffButtonForIndex(resolved);
                }
            }
        }

        function syncLatestThreeButtonsByMessageNode(messageNode) {
            const index = getMessageIndexFromNode(messageNode);
            if (index < 0) return;
            syncLatestThreeButtonsByNewestIndex(index);
        }

        function observeNewMessages() {
            const chat = getChatRoot();
            if (!chat) return null;
            if (state.observer) return state.observer;

            const observer = new MutationObserver((mutations) => {
                for (const mutation of mutations) {
                    for (const added of mutation.addedNodes) {
                        if (!(added instanceof HTMLElement)) continue;

                        if (added.matches?.('.mes')) {
                            syncLatestThreeButtonsByMessageNode(added);
                            continue;
                        }

                        const mes = added.querySelector?.('.mes');
                        if (mes) {
                            syncLatestThreeButtonsByMessageNode(mes);
                        }
                    }
                }
            });

            observer.observe(chat, { childList: true, subtree: true });
            state.observer = observer;
            return observer;
        }

        function initLatestThreeButtons() {
            const nodes = getMessageNodes();
            if (!nodes.length) return;

            const newestNode = nodes[nodes.length - 1];
            const newestIndex = getMessageIndexFromNode(newestNode);
            syncLatestThreeButtonsByNewestIndex(newestIndex >= 0 ? newestIndex : nodes.length - 1);
        }

        return {
            state,
            getChatRoot,
            getMessageNodes,
            getMessageIndexFromNode,
            getMessageNodeByIndex,
            initLatestThreeButtons,
            syncLatestThreeButtonsByNewestIndex,
            syncLatestThreeButtonsByIndices,
            syncLatestThreeButtonsByMessageNode,
            observeNewMessages,
        };
    })();

    return window.THKeywordFilterLatest3;
}

function seedTrackedLatestFromHelper(helper) {
    if (!helper || runtimeState.latestDiffMessageIndices.length > 0) return;
    const initial = Array.isArray(helper.state?.latestThree) ? helper.state.latestThree : [];
    const cleaned = initial
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value >= 0)
        .slice(-MAX_TRACKED_DIFF_MESSAGES);
    if (!cleaned.length) return;
    runtimeState.latestDiffMessageIndices = [...cleaned];
    persistLatestDiffStateForCurrentChat();
}

export function initLatestThreeButtonsLayer() {
    const helper = ensureLatest3ButtonHelper();
    helper.initLatestThreeButtons();
    seedTrackedLatestFromHelper(helper);
    helper.observeNewMessages();
}

/**
 * 兼容旧调用入口，但按钮注入现在只负责“最新三层按钮注入”。
 * 不再耦合 loading / ready / 对比构建逻辑。
 * @param {number} index 消息索引。
 * @param {Element} messageNode 消息 DOM 节点。
 * @returns {void}
 */
export function ensureMessageDiffButton(index, messageNode) {
    const helper = ensureLatest3ButtonHelper();
    if (messageNode) {
        helper.syncLatestThreeButtonsByMessageNode(messageNode);
        return;
    }
    if (Number.isInteger(index) && index >= 0) {
        helper.syncLatestThreeButtonsByNewestIndex(index);
    }
}

/**
 * 扫描当前聊天区域并按“当前聊天最新 3 条”注入对比按钮。
 * 只负责按钮出现与淘汰，不处理 ready / loading。
 * @returns {void}
 */
export function injectDiffButtons() {
    const { extension_settings } = getAppContext();
    const isEnabled = extension_settings[extensionName]?.enableVisualDiff !== false;
    const helper = ensureLatest3ButtonHelper();

    if (!isEnabled) {
        helper.syncLatestThreeButtonsByIndices([]);
        return;
    }

    const tracked = runtimeState.latestDiffMessageIndices
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value >= 0);

    if (tracked.length > 0) {
        helper.syncLatestThreeButtonsByIndices(tracked);
    } else {
        helper.initLatestThreeButtons();
        seedTrackedLatestFromHelper(helper);
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
