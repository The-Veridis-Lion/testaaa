import { extensionName, getAppContext, runtimeState } from './state.js';
import { applyReplacements } from './core.js';

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

export function getDiffStatus(index) {
    const state = runtimeState.diffStatusCache.get(index);
    return state || 'idle';
}

export function setDiffStatus(index, status) {
    if (!Number.isInteger(index) || index < 0) return;
    runtimeState.diffStatusCache.set(index, status || 'idle');
    document.dispatchEvent(new CustomEvent('bl-diff-state-changed', { detail: { index, status: status || 'idle' } }));
}

export function scheduleDiffButtonSync(indices) {
    if (!indices || typeof indices[Symbol.iterator] !== 'function') return;
    for (const rawIndex of indices) {
        const index = Number(rawIndex);
        if (Number.isInteger(index) && index >= 0) runtimeState.pendingDiffButtonIndices.add(index);
    }
    if (runtimeState.diffButtonSyncScheduled) return;
    runtimeState.diffButtonSyncScheduled = true;
    requestAnimationFrame(() => {
        runtimeState.diffButtonSyncScheduled = false;
        const pending = Array.from(runtimeState.pendingDiffButtonIndices);
        runtimeState.pendingDiffButtonIndices.clear();
        injectDiffButtonsForIndices(pending);
    });
}

export function retainOnlyLatestDiffState(latestIndex) {
    latestIndex = Number(latestIndex);
    const keepLatest = Number.isInteger(latestIndex) && latestIndex >= 0;

    for (const [idx, timer] of runtimeState.diffJobTimers.entries()) {
        if (!keepLatest || idx !== latestIndex) {
            clearTimeout(timer);
            runtimeState.diffJobTimers.delete(idx);
        }
    }

    for (const cache of [runtimeState.diffSnippetsCache, runtimeState.diffStatusCache, runtimeState.diffSourceTextCache]) {
        for (const key of Array.from(cache.keys())) {
            if (!keepLatest || key !== latestIndex) cache.delete(key);
        }
    }
}

export function queueDiffComputation(index, rawText) {
    if (!Number.isInteger(index) || index < 0) return;
    if (typeof rawText !== 'string') rawText = '';

    retainOnlyLatestDiffState(index);

    const prevTimer = runtimeState.diffJobTimers.get(index);
    if (prevTimer) clearTimeout(prevTimer);

    runtimeState.diffSourceTextCache.set(index, rawText);
    setDiffStatus(index, 'pending');
    scheduleDiffButtonSync([index]);

    const timer = setTimeout(() => {
        runtimeState.diffJobTimers.delete(index);
        const sourceText = runtimeState.diffSourceTextCache.get(index) ?? rawText;
        const result = buildDiffSnippetsFromText(sourceText);
        updateDiffSnippetCache(index, { snippets: Array.from(new Set(result.snippets || [])), fullDiff: result.fullDiff || '' });
        runtimeState.diffSourceTextCache.delete(index);
        setDiffStatus(index, 'ready');
        scheduleDiffButtonSync([index]);
        document.dispatchEvent(new CustomEvent('bl-diff-ready', { detail: { index } }));
    }, 0);

    runtimeState.diffJobTimers.set(index, timer);
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
 * 更新指定消息的差异缓存。
 * @param {number} index 消息索引。
 * @param {{snippets?: string[], fullDiff?: string}} cacheData 差异缓存数据。
 * @returns {void}
 */
export function updateDiffSnippetCache(index, cacheData) {
    if (!Number.isInteger(index) || index < 0) return;
    if (!cacheData || ((!Array.isArray(cacheData.snippets) || cacheData.snippets.length === 0) && !cacheData.fullDiff)) {
        runtimeState.diffSnippetsCache.delete(index);
        return;
    }
    runtimeState.diffSnippetsCache.set(index, cacheData);
}

/**
 * 确保消息节点拥有正确的“净化前文溯源”按钮状态。
 * @param {number} index 消息索引。
 * @param {Element} messageNode 消息 DOM 节点。
 * @returns {void}
 */
export function ensureMessageDiffButton(index, messageNode) {
    if (!messageNode || !Number.isInteger(index) || index < 0) return;

    const { extension_settings } = getAppContext();
    const isEnabled = extension_settings[extensionName]?.enableVisualDiff !== false;
    const isTopInExtra = extension_settings[extensionName]?.diffButtonInExtraMenu === true;
    const status = getDiffStatus(index);
    const isStreaming = status === 'streaming';
    const isPending = status === 'pending';
    const isReady = status === 'ready';

    const applyButtonState = (button) => {
        if (!button) return;
        button.setAttribute('data-index', String(index));
        button.setAttribute('data-state', status);
        button.classList.toggle('is-disabled', isStreaming);
        button.classList.toggle('is-pending', isPending);
        button.classList.toggle('is-ready', isReady);
        button.classList.toggle('interactable', !isStreaming);
        if (isStreaming) {
            button.setAttribute('aria-disabled', 'true');
            button.title = '生成中';
        } else if (isPending) {
            button.removeAttribute('aria-disabled');
            button.title = 'Loading';
        } else {
            button.removeAttribute('aria-disabled');
            button.title = '溯源净化前文';
        }
    };

    const buttonArea = messageNode.querySelector('.mes_buttons');
    if (buttonArea) {
        let existing = buttonArea.querySelector('.bl-diff-btn-top');
        const extraMenu = buttonArea.querySelector('.extraMesButtons');
        const targetContainer = (isTopInExtra && extraMenu) ? extraMenu : buttonArea;

        if (existing && existing.parentElement !== targetContainer) {
            existing.remove();
            existing = null;
        }

        if (!isEnabled) {
            if (existing) existing.remove();
        } else if (!existing) {
            const button = document.createElement('div');
            button.className = 'mes_button bl-diff-btn bl-diff-btn-top fa-solid fa-clock-rotate-left';
            button.setAttribute('tabindex', '0');
            button.setAttribute('role', 'button');
            if (isTopInExtra && extraMenu) {
                extraMenu.appendChild(button);
            } else {
                const editBtn = buttonArea.querySelector('.mes_edit');
                if (editBtn) buttonArea.insertBefore(button, editBtn);
                else buttonArea.appendChild(button);
            }
            existing = button;
        }

        applyButtonState(existing);
    }

    const swipeBlock = messageNode.querySelector('.swipeRightBlock');
    if (swipeBlock) {
        const parent = swipeBlock.parentNode;
        let existingBottom = parent?.querySelector('.bl-diff-btn-bottom');

        if (!isEnabled) {
            if (existingBottom) existingBottom.remove();
        } else if (!existingBottom && parent) {
            const btnBottom = document.createElement('div');
            btnBottom.className = 'bl-diff-btn bl-diff-btn-bottom fa-solid fa-clock-rotate-left';
            btnBottom.setAttribute('tabindex', '0');
            btnBottom.setAttribute('role', 'button');
            parent.insertBefore(btnBottom, swipeBlock);
            existingBottom = btnBottom;
        }

        applyButtonState(existingBottom);
    }
}

/**
 * 扫描当前聊天区域并按消息索引注入差异按钮。
 */
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

export function injectDiffButtonsForIndices(indices) {
    if (!indices || typeof indices[Symbol.iterator] !== 'function') return;
    for (const rawIndex of indices) {
        const index = Number(rawIndex);
        if (!Number.isInteger(index) || index < 0) continue;
        const chatEl = document.getElementById('chat');
        if (!chatEl) return;
        const selectors = [`.mes[mesid="${index}"]`, `.mes[data-mesid="${index}"]`, `.mes[messageid="${index}"]`, `.mes[data-message-id="${index}"]`];
        let node = null;
        for (const selector of selectors) {
            node = chatEl.querySelector(selector);
            if (node) break;
        }
        if (!node) {
            const allMes = chatEl.querySelectorAll('.mes');
            node = allMes[index] || null;
        }
        if (node) ensureMessageDiffButton(index, node);
    }
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
    runtimeState.diffStatusCache.clear();
    runtimeState.diffSourceTextCache.clear();
    for (const timer of runtimeState.diffJobTimers.values()) clearTimeout(timer);
    runtimeState.diffJobTimers.clear();
}
