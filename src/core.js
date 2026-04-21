import { extensionName, getAppContext, runtimeState } from './state.js';
import { buildSimpleWildcardPattern } from './utils.js';
import { deepCleanObjectSync } from './cleanse.js';
import { buildDiffSnippetsFromText, clearDiffSnippetsCache, ensureMessageDiffButton, injectDiffButtons, injectDiffButtonsForIndices, updateDiffSnippetCache, isDiffEligibleIndex, setDiffState, clearDiffState, pruneDiffTracking } from './diff.js';
import { getMessageDomNode, purifyDOM, purifyTextSubtree } from './dom.js';

/**
 * 根据当前规则构建净化处理器（文本/正则/简易语法）。
 * @returns {Array} 可复用的处理器数组。
 */
export function buildProcessors() {
    if (!runtimeState.isRegexDirty) return runtimeState.activeProcessors;
    const { extension_settings } = getAppContext();
    const rules = extension_settings[extensionName]?.rules || [];

    let textTargets = [];
    let wordToReplacements = Object.create(null);
    let processors = [];

    for (const rule of rules) {
        if (rule.enabled === false) continue;
        const subRulesToProcess = Array.isArray(rule.subRules) ? rule.subRules : [];

        for (const sub of subRulesToProcess) {
            const mode = sub.mode || 'text';
            const targets = Array.isArray(sub.targets) ? sub.targets : [];
            const replacements = Array.isArray(sub.replacements) ? sub.replacements : [];

            if (mode === 'text') {
                for (const t of targets) {
                    if (t) {
                        textTargets.push(t);
                        wordToReplacements[t] = replacements;
                    }
                }
            } else if (mode === 'regex') {
                for (const t of targets) {
                    if (t) {
                        try {
                            let pattern = t;
                            let flags = 'gmu';
                            if (t.startsWith('/')) {
                                const lastSlash = t.lastIndexOf('/');
                                if (lastSlash > 0) {
                                    pattern = t.substring(1, lastSlash);
                                    flags = t.substring(lastSlash + 1);
                                    if (!flags.includes('g')) flags += 'g';
                                }
                            }

                            let testRegex = new RegExp(pattern, flags);
                            if (testRegex.test("")) {
                                console.warn("[Ultimate Purifier] 拦截到一个危险的空匹配正则，已忽略:", t);
                                return;
                            }

                            processors.push({ regex: testRegex, replacements, isRegexMode: true });
                        } catch (e) {
                            console.warn("[Ultimate Purifier] 忽略非法正则表达式:", t);
                        }
                    }
                }
            } else if (mode === 'simple') {
                for (const t of targets) {
                    if (t) {
                        try {
                            let escaped = t.replace(/[.+^$()[\]\\]/g, '\\$&');
                            // 解析简易语法中的 {A,B} 备选分组。
                            escaped = escaped.replace(/\{([^}]+)\}/g, (match, group) => {
                                return '(?:' + group.split(',').map(s => s.trim()).join('|') + ')';
                            });
                            // 解析简易语法中的 * 通配符为受限匹配片段。
                            escaped = escaped.replace(/\*/g, buildSimpleWildcardPattern());

                            let testRegex = new RegExp(escaped, 'gmu');
                            if (testRegex.test("")) {
                                console.warn("[Ultimate Purifier] 拦截到一个危险的简易空匹配规则，已忽略:", t);
                                return;
                            }

                            processors.push({ regex: testRegex, replacements, isRegexMode: true });
                        } catch (e) {
                            console.warn("[Ultimate Purifier] 简易规则解析失败:", t);
                        }
                    }
                }
            }
        }
    }

    if (textTargets.length > 0) {
        const uniqueTargets = [...new Set(textTargets)];
        const sorted = uniqueTargets.sort((a, b) => b.length - a.length);
        const escaped = sorted.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        const textRegex = new RegExp(`(${escaped.join('|')})`, 'gmu');
        processors.unshift({ regex: textRegex, replacerMap: wordToReplacements, isRegexMode: false });
    }

    runtimeState.activeProcessors = processors;
    runtimeState.isRegexDirty = false;
    return runtimeState.activeProcessors;
}

/**
 * 从替换词列表中选择一个替换值（可选确定性模式）。
 * @param {string[]} replacements 候选替换词列表。
 * @param {string} [deterministicKey=""] 确定性模式键。
 * @returns {string} 最终替换词。
 */
export function pickReplacement(replacements, deterministicKey = "") {
    if (!Array.isArray(replacements) || replacements.length === 0) return '';
    if (!deterministicKey) {
        const randIndex = Math.floor(Math.random() * replacements.length);
        return replacements[randIndex];
    }

    let hash = 0;
    for (let i = 0; i < deterministicKey.length; i++) {
        hash = ((hash << 5) - hash) + deterministicKey.charCodeAt(i);
        hash |= 0;
    }
    const idx = Math.abs(hash) % replacements.length;
    return replacements[idx];
}

/**
 * 对文本应用规则替换。
 * @param {string} originalText 原始文本。
 * @param {{deterministic?: boolean}} [options={}] 替换选项。
 * @returns {string} 替换后的文本。
 */
export function applyReplacements(originalText, options = {}) {
    if (typeof originalText !== 'string' || !originalText) return originalText;
    const deterministic = options.deterministic === true;
    let text = originalText;
    const processors = buildProcessors();

    processors.forEach((proc, procIndex) => {
        text = text.replace(proc.regex, (match, ...args) => {
            if (proc.isRegexMode) {
                const reps = proc.replacements;
                if (!reps || reps.length === 0) return '';
                const repKey = deterministic ? `${procIndex}|${match}` : '';
                let rep = pickReplacement(reps, repKey);
                rep = String(rep ?? '');
                rep = rep.replace(/\$(\d+)/g, (m, g) => {
                    const idx = parseInt(g);
                    return args[idx - 1] !== undefined ? args[idx - 1] : m;
                });
                return rep;
            }

            const reps = proc.replacerMap[match];
            if (!reps || reps.length === 0) return '';
            const repKey = deterministic ? `${procIndex}|${match}` : '';
            return pickReplacement(reps, repKey);
        });
    });
    return text;
}

/**
 * 在流式展示场景下执行确定性视觉替换。
 * @param {string} originalText 原始文本。
 * @returns {string} 视觉掩码后的文本。
 */
export function applyVisualMask(originalText) {
    if (typeof originalText !== 'string' || !originalText) return originalText;
    return applyReplacements(originalText, { deterministic: true });
}

/**
 * 排队执行增量聊天保存，合并短时间内的重复请求。
 * @returns {void}
 */
export function queueIncrementalChatSave() {
    const { saveChat } = getAppContext();
    runtimeState.pendingChatSave = true;
    if (runtimeState.chatSaveTimer) return;

    runtimeState.chatSaveTimer = setTimeout(async () => {
        runtimeState.chatSaveTimer = null;
        if (!runtimeState.pendingChatSave) return;
        if (runtimeState.chatSaveInFlight) {
            queueIncrementalChatSave();
            return;
        }

        runtimeState.pendingChatSave = false;
        runtimeState.chatSaveInFlight = true;
        try {
            if (typeof saveChat === 'function') {
                const result = saveChat();
                if (result instanceof Promise) await result;
            }
        } catch (e) {
            console.error("[Ultimate Purifier] 增量存盘失败", e);
        } finally {
            runtimeState.chatSaveInFlight = false;
            if (runtimeState.pendingChatSave) queueIncrementalChatSave();
        }
    }, 180);
}

/**
 * 从事件负载中解析消息索引。
 * @param {number|object} payload 事件载荷或直接索引。
 * @returns {number} 解析出的索引，失败返回 -1。
 */
export function getMessageIndexFromEvent(payload) {
    if (Number.isInteger(payload)) return payload;
    if (!payload || typeof payload !== 'object') return -1;
    const candidates = [payload.messageId, payload.message_id, payload.mesid, payload.index, payload.id];
    for (const value of candidates) {
        const n = Number(value);
        if (Number.isInteger(n) && n >= 0) return n;
    }
    return -1;
}

/**
 * 获取当前聊天中的最后一条消息索引。
 * @returns {number} 最新消息索引，不存在则为 -1。
 */
export function getLatestMessageIndex() {
    const { chat } = getAppContext();
    return Array.isArray(chat) && chat.length > 0 ? chat.length - 1 : -1;
}


function cloneRawDiffBundle(msg) {
    if (!msg || typeof msg !== 'object') return null;
    return {
        mes: typeof msg.mes === 'string' ? msg.mes : '',
        swipes: Array.isArray(msg.swipes) ? msg.swipes.map((item) => {
            if (typeof item === 'string') return item;
            if (item && typeof item === 'object' && typeof item.mes === 'string') return item.mes;
            return '';
        }) : [],
    };
}

function buildDiffCacheFromBundle(rawBundle) {
    const allSnippets = [];
    let mainFullDiff = '';
    if (rawBundle && typeof rawBundle.mes === 'string') {
        const main = buildDiffSnippetsFromText(rawBundle.mes);
        allSnippets.push(...main.snippets);
        mainFullDiff = main.fullDiff;
    }
    if (rawBundle && Array.isArray(rawBundle.swipes)) {
        for (const swipe of rawBundle.swipes) {
            if (typeof swipe !== 'string' || !swipe) continue;
            const swipeDiff = buildDiffSnippetsFromText(swipe);
            allSnippets.push(...swipeDiff.snippets);
        }
    }
    return { snippets: Array.from(new Set(allSnippets)), fullDiff: mainFullDiff };
}

function scheduleDiffBuild(index, rawBundle) {
    if (!Number.isInteger(index) || index < 0) return;
    if (!isDiffEligibleIndex(index)) {
        clearDiffState(index);
        updateDiffSnippetCache(index, null);
        return;
    }

    const oldTimer = runtimeState.diffBuildTimers.get(index);
    if (oldTimer) clearTimeout(oldTimer);
    runtimeState.diffRawSourceMap.set(index, rawBundle || null);
    setDiffState(index, 'pending');
    const timer = setTimeout(() => {
        runtimeState.diffBuildTimers.delete(index);
        const currentBundle = runtimeState.diffRawSourceMap.get(index);
        if (!isDiffEligibleIndex(index) || !currentBundle) {
            clearDiffState(index);
            updateDiffSnippetCache(index, null);
            return;
        }
        const cache = buildDiffCacheFromBundle(currentBundle);
        updateDiffSnippetCache(index, cache);
        runtimeState.diffRawSourceMap.delete(index);
        setDiffState(index, 'ready');
    }, 120);
    runtimeState.diffBuildTimers.set(index, timer);
}

/**
 * 清理指定索引消息的数据，并仅为最新 3 条消息保留异步对比原文。
 * @param {number} index 消息索引。
 * @returns {{changed: boolean, rawBundle: object|null}} 是否发生数据变更以及原文快照。
 */
export function cleanseMessageDataAtIndex(index) {
    const { chat } = getAppContext();
    if (!Array.isArray(chat) || index < 0 || index >= chat.length) return { changed: false, rawBundle: null };
    const msg = chat[index];
    if (!msg || typeof msg !== 'object') return { changed: false, rawBundle: null };

    const eligible = isDiffEligibleIndex(index);
    const rawBundle = eligible ? cloneRawDiffBundle(msg) : null;
    let changed = false;

    if (typeof msg.mes === 'string') {
        const cleanedText = applyReplacements(msg.mes);
        if (cleanedText !== msg.mes) {
            msg.mes = cleanedText;
            changed = true;
        }
    }

    if (Array.isArray(msg.swipes)) {
        for (let i = 0; i < msg.swipes.length; i++) {
            if (typeof msg.swipes[i] === 'string') {
                const cleanedText = applyReplacements(msg.swipes[i]);
                if (cleanedText !== msg.swipes[i]) {
                    msg.swipes[i] = cleanedText;
                    changed = true;
                }
            } else if (msg.swipes[i] && typeof msg.swipes[i] === 'object' && typeof msg.swipes[i].mes === 'string') {
                const cleanedText = applyReplacements(msg.swipes[i].mes);
                if (cleanedText !== msg.swipes[i].mes) {
                    msg.swipes[i].mes = cleanedText;
                    changed = true;
                }
            }
        }
    }

    if (!eligible) {
        updateDiffSnippetCache(index, null);
        clearDiffState(index);
    }

    return { changed, rawBundle };
}

/**
 * 执行增量净化：处理单条消息并刷新对应 DOM。
 * @param {number|object} payload 事件载荷或消息索引。
 * @param {{visualOnly?: boolean, fallbackLatest?: boolean}} [options={}] 控制选项。
 * @returns {void}
 */
export function performIncrementalCleanse(payload, options = {}) {
    const { chat } = getAppContext();
    buildProcessors();
    if (runtimeState.activeProcessors.length === 0) return;

    const fallbackLatest = options.fallbackLatest !== false;
    let index = getMessageIndexFromEvent(payload);
    if (index < 0 && fallbackLatest) index = getLatestMessageIndex();
    if (index < 0) return;

    const visualOnly = options.visualOnly === true;
    const messageNode = getMessageDomNode(index);

    if (visualOnly) {
        if (isDiffEligibleIndex(index)) {
            pruneDiffTracking();
            setDiffState(index, 'streaming');
            injectDiffButtonsForIndices([index, index - 1, index - 2, index - 3]);
        }
        if (messageNode) purifyTextSubtree(messageNode);
        return;
    }

    const cleanseResult = cleanseMessageDataAtIndex(index);
    const dataChanged = !!cleanseResult.changed;
    pruneDiffTracking();

    if (isDiffEligibleIndex(index)) scheduleDiffBuild(index, cleanseResult.rawBundle);

    if (dataChanged) {
        try {
            if (typeof updateMessageBlock === 'function') {
                updateMessageBlock(index, chat[index]);
                setTimeout(() => injectDiffButtonsForIndices([index, index - 1, index - 2, index - 3]), 60);
            } else if (messageNode) {
                purifyDOM(messageNode);
                ensureMessageDiffButton(index, messageNode);
            }
        } catch (e) {
            if (messageNode) {
                purifyDOM(messageNode);
                ensureMessageDiffButton(index, messageNode);
            }
        }
        queueIncrementalChatSave();
        return;
    }

    if (messageNode) {
        purifyDOM(messageNode);
        ensureMessageDiffButton(index, messageNode);
    }
    injectDiffButtonsForIndices([index, index - 1, index - 2, index - 3]);
}

/**
 * 执行当前角色卡当前聊天的可见消息净化。
 * 仅处理当前聊天中未被隐藏的消息节点，不在启动时全量替换历史聊天。
 * @returns {void}
 */
export function performGlobalCleanse() {
    const { chat, saveChat } = getAppContext();
    buildProcessors();
    if (runtimeState.activeProcessors.length === 0) {
        clearDiffSnippetsCache();
        pruneDiffTracking();
        injectDiffButtons();
        return;
    }

    const chatEl = document.getElementById('chat');
    if (!chatEl || !Array.isArray(chat)) {
        pruneDiffTracking();
        injectDiffButtons();
        return;
    }

    const visibleNodes = Array.from(chatEl.querySelectorAll('.mes')).filter((node) => {
        if (!node || node.classList?.contains('displayNone') || node.hidden) return false;
        const style = window.getComputedStyle ? window.getComputedStyle(node) : null;
        return !style || (style.display !== 'none' && style.visibility !== 'hidden');
    });

    let chatChanged = false;
    clearDiffSnippetsCache();
    pruneDiffTracking();

    for (const node of visibleNodes) {
        const attrs = [node.getAttribute('mesid'), node.getAttribute('data-mesid'), node.getAttribute('messageid'), node.getAttribute('data-message-id')];
        let index = -1;
        for (const raw of attrs) {
            const n = Number(raw);
            if (Number.isInteger(n) && n >= 0) { index = n; break; }
        }
        if (index < 0 || index >= chat.length) continue;
        const result = cleanseMessageDataAtIndex(index);
        if (result.changed) {
            chatChanged = true;
            try { if (typeof updateMessageBlock === 'function') setTimeout(() => updateMessageBlock(index, chat[index]), 50); } catch (e) {}
        }
        if (isDiffEligibleIndex(index)) scheduleDiffBuild(index, result.rawBundle);
        else clearDiffState(index);
    }

    if (chatChanged) {
        try { if (typeof saveChat === 'function') saveChat(); } catch (e) { console.error('[Ultimate Purifier] 存盘失败', e); }
    }

    purifyDOM(chatEl);
    injectDiffButtons();
}
