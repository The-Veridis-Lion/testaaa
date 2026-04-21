import { extensionName, getAppContext, runtimeState } from './state.js';
import { applyReplacements } from './core.js';

export function escapeHtml(value = '') {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

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
            if (oldChars[i - 1] === newChars[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
            else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
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
        } else if (i > 0) {
            diff.push(`<del>${escapeHtml(oldChars[i - 1])}</del>`);
            i--;
        }
    }

    return diff.reverse().join('')
        .replace(/<\/ins><ins>/g, '')
        .replace(/<\/del><del>/g, '');
}

export function buildDiffSnippetsFromText(rawText) {
    if (typeof rawText !== 'string') return { cleanedText: rawText, snippets: [], fullDiff: "" };
    const parts = rawText.split('\n');
    const cleanedParts = new Array(parts.length);
    const snippets = [];

    for (let i = 0; i < parts.length; i++) {
        const originalPart = parts[i];
        const cleanedPart = applyReplacements(originalPart);
        cleanedParts[i] = cleanedPart;
        if (cleanedPart !== originalPart) snippets.push(`<div class="bl-diff-snippet">${getInlineDiff(originalPart, cleanedPart)}</div>`);
    }

    const cleanedText = cleanedParts.join('\n');
    let targetText = rawText;
    const contentMatch = rawText.match(/<content>([\s\S]*?)<\/content>/i);
    if (contentMatch) targetText = contentMatch[1].trim();

    const fullBlocks = [];
    for (const part of targetText.split('\n')) {
        const originalPart = part.trim();
        if (!originalPart) continue;
        const cleanedPart = applyReplacements(originalPart);
        if (cleanedPart !== originalPart) fullBlocks.push(`<div class="bl-diff-full-modified">${getInlineDiff(originalPart, cleanedPart)}</div>`);
        else fullBlocks.push(`<div class="bl-diff-full-normal">${escapeHtml(originalPart)}</div>`);
    }

    return { cleanedText, snippets, fullDiff: fullBlocks.join('') };
}

export function getLatestDiffEligibleIndices() {
    const { chat } = getAppContext();
    const size = Math.max(1, Number(runtimeState.diffLimit) || 3);
    if (!Array.isArray(chat) || chat.length === 0) return [];
    const start = Math.max(0, chat.length - size);
    const indices = [];
    for (let i = start; i < chat.length; i++) indices.push(i);
    return indices;
}

export function isDiffEligibleIndex(index) {
    if (!Number.isInteger(index) || index < 0) return false;
    return getLatestDiffEligibleIndices().includes(index);
}

export function setDiffState(index, state) {
    if (!Number.isInteger(index) || index < 0) return;
    runtimeState.diffStatusMap.set(index, state);
    document.dispatchEvent(new CustomEvent('bl:diff-state-changed', { detail: { index, state } }));
}

export function getDiffState(index) {
    if (!Number.isInteger(index) || index < 0) return 'idle';
    return runtimeState.diffStatusMap.get(index) || 'idle';
}

export function clearDiffState(index) {
    if (!Number.isInteger(index) || index < 0) return;
    runtimeState.diffStatusMap.delete(index);
    runtimeState.diffRawSourceMap.delete(index);
    const timer = runtimeState.diffBuildTimers.get(index);
    if (timer) clearTimeout(timer);
    runtimeState.diffBuildTimers.delete(index);
    runtimeState.diffSignatureMap.delete(index);
    document.dispatchEvent(new CustomEvent('bl:diff-state-changed', { detail: { index, state: 'idle' } }));
}

export function pruneDiffTracking() {
    const keep = new Set(getLatestDiffEligibleIndices());
    for (const index of Array.from(runtimeState.diffStatusMap.keys())) {
        if (!keep.has(index)) clearDiffState(index);
    }
    for (const index of Array.from(runtimeState.diffSnippetsCache.keys())) {
        if (!keep.has(index)) runtimeState.diffSnippetsCache.delete(index);
    }
}

export function updateDiffSnippetCache(index, cacheData) {
    if (!Number.isInteger(index) || index < 0) return;
    if (!cacheData || ((!Array.isArray(cacheData.snippets) || cacheData.snippets.length === 0) && !cacheData.fullDiff)) {
        runtimeState.diffSnippetsCache.delete(index);
        return;
    }
    runtimeState.diffSnippetsCache.set(index, cacheData);
}

function applyButtonState(button, index) {
    const state = getDiffState(index);
    button.setAttribute('data-index', String(index));
    button.setAttribute('data-diff-state', state);
    button.classList.toggle('is-disabled', state === 'streaming');
    button.classList.toggle('is-pending', state === 'pending');
    button.classList.toggle('is-ready', state === 'ready');
    if (state === 'streaming') {
        button.setAttribute('aria-disabled', 'true');
        button.title = '生成中，稍后可查看';
    } else if (state === 'pending') {
        button.removeAttribute('aria-disabled');
        button.title = '对比内容准备中';
    } else {
        button.removeAttribute('aria-disabled');
        button.title = '溯源净化前文';
    }
}

function resolveIndexFromMessageNode(messageNode) {
    if (!messageNode) return -1;
    const attrs = [messageNode.getAttribute('mesid'), messageNode.getAttribute('data-mesid'), messageNode.getAttribute('messageid'), messageNode.getAttribute('data-message-id')];
    for (const raw of attrs) {
        const n = Number(raw);
        if (Number.isInteger(n) && n >= 0) return n;
    }
    const chatEl = document.getElementById('chat');
    if (!chatEl) return -1;
    const allMes = Array.from(chatEl.querySelectorAll('.mes'));
    return allMes.indexOf(messageNode);
}

export function ensureMessageDiffButton(index, messageNode) {
    if (!messageNode || !Number.isInteger(index) || index < 0) return;
    const { extension_settings } = getAppContext();
    const isEnabled = extension_settings[extensionName]?.enableVisualDiff !== false;
    const isTopInExtra = extension_settings[extensionName]?.diffButtonInExtraMenu === true;
    const shouldShow = isEnabled && isDiffEligibleIndex(index);

    if (shouldShow && getDiffState(index) === 'idle') {
        const inferredState = runtimeState.isStreamingGeneration && (runtimeState.currentStreamingDiffIndex === -1 || runtimeState.currentStreamingDiffIndex === index)
            ? 'streaming'
            : 'pending';
        runtimeState.diffStatusMap.set(index, inferredState);
    }

    const buttonArea = messageNode.querySelector('.mes_buttons');
    if (buttonArea) {
        let existing = buttonArea.querySelector('.bl-diff-btn-top');
        const extraMenu = buttonArea.querySelector('.extraMesButtons');
        const targetContainer = (isTopInExtra && extraMenu) ? extraMenu : buttonArea;
        if (existing && existing.parentElement !== targetContainer) { existing.remove(); existing = null; }
        if (!shouldShow) {
            if (existing) existing.remove();
        } else if (!existing) {
            const button = document.createElement('div');
            button.className = 'mes_button bl-diff-btn bl-diff-btn-top fa-solid fa-clock-rotate-left interactable';
            button.setAttribute('tabindex', '0');
            button.setAttribute('role', 'button');
            if (isTopInExtra && extraMenu) extraMenu.appendChild(button);
            else {
                const editBtn = buttonArea.querySelector('.mes_edit');
                if (editBtn) buttonArea.insertBefore(button, editBtn);
                else buttonArea.appendChild(button);
            }
            existing = button;
        }
        if (existing) applyButtonState(existing, index);
    }

    const swipeBlock = messageNode.querySelector('.swipeRightBlock');
    if (swipeBlock) {
        const parent = swipeBlock.parentNode;
        const existingBottom = parent?.querySelector('.bl-diff-btn-bottom');
        if (!shouldShow) {
            if (existingBottom) existingBottom.remove();
        } else if (!existingBottom && parent) {
            const btnBottom = document.createElement('div');
            btnBottom.className = 'bl-diff-btn bl-diff-btn-bottom fa-solid fa-clock-rotate-left interactable';
            btnBottom.setAttribute('tabindex', '0');
            btnBottom.setAttribute('role', 'button');
            parent.insertBefore(btnBottom, swipeBlock);
            applyButtonState(btnBottom, index);
        } else if (existingBottom) {
            applyButtonState(existingBottom, index);
        }
    }
}


export function ensureDiffButtonsForMessageNode(messageNode) {
    if (!messageNode || messageNode.nodeType !== 1) return;
    if (messageNode.classList?.contains('mes')) {
        const index = resolveIndexFromMessageNode(messageNode);
        if (index >= 0) ensureMessageDiffButton(index, messageNode);
        return;
    }
    const nestedMessages = messageNode.querySelectorAll?.('.mes');
    if (!nestedMessages || nestedMessages.length === 0) return;
    nestedMessages.forEach((node) => {
        const index = resolveIndexFromMessageNode(node);
        if (index >= 0) ensureMessageDiffButton(index, node);
    });
}

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
            if (Number.isInteger(n) && n >= 0) { index = n; break; }
        }
        if (index < 0) index = i;
        ensureMessageDiffButton(index, node);
    }
}

export function injectDiffButtonsForIndices(indices) {
    if (!indices || typeof indices[Symbol.iterator] !== 'function') return;
    const chatEl = document.getElementById('chat');
    if (!chatEl) return;
    for (const rawIndex of indices) {
        const index = Number(rawIndex);
        if (!Number.isInteger(index) || index < 0) continue;
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

export function getDiffSnippetsForMessage(index) {
    const cached = runtimeState.diffSnippetsCache.get(index);
    if (!cached || typeof cached !== 'object') return { snippets: [], fullDiff: '' };
    return {
        snippets: Array.isArray(cached.snippets) ? cached.snippets : [],
        fullDiff: String(cached.fullDiff || ''),
    };
}

export function clearDiffSnippetsCache() {
    runtimeState.diffSnippetsCache.clear();
}
