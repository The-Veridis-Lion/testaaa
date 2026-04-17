import { defaultSettings, extensionName, getAppContext, runtimeState } from './state.js';
import { buildSimpleWildcardPattern } from './utils.js';
import { showDeepCleanOverlay, updateDeepCleanOverlay } from './ui.js';

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
                            escaped = escaped.replace(/\{([^}]+)\}/g, (match, group) => {
                                return '(?:' + group.split(',').map(s => s.trim()).join('|') + ')';
                            });
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

export function applyVisualMask(originalText) {
    if (typeof originalText !== 'string' || !originalText) return originalText;
    return applyReplacements(originalText, { deterministic: true });
}


function escapeHtml(value = '') {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function getInlineDiff(oldStr, newStr) {
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

function buildDiffSnippetsFromText(rawText) {
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
    const cleanedFull = applyReplacements(targetText);
    const fullDiff = getInlineDiff(targetText, cleanedFull);

    return {
        cleanedText,
        snippets,
        fullDiff,
    };
}

function updateDiffSnippetCache(index, cacheData) {
    if (!Number.isInteger(index) || index < 0) return;
    if (!cacheData || ((!Array.isArray(cacheData.snippets) || cacheData.snippets.length === 0) && !cacheData.fullDiff)) {
        runtimeState.diffSnippetsCache.delete(index);
        return;
    }
    runtimeState.diffSnippetsCache.set(index, cacheData);
}

function ensureMessageDiffButton(index, messageNode) {
    if (!messageNode || !Number.isInteger(index) || index < 0) return;

    const { extension_settings } = getAppContext();
    const isEnabled = extension_settings[extensionName]?.enableVisualDiff !== false;
    const cached = runtimeState.diffSnippetsCache.get(index);
    const hasSnippets = !!(cached && ((Array.isArray(cached.snippets) && cached.snippets.length > 0) || cached.fullDiff !== ""));

    const buttonArea = messageNode.querySelector('.mes_buttons');
    if (buttonArea) {
        const existing = buttonArea.querySelector('.bl-diff-btn-top');
        if (!isEnabled || !hasSnippets) {
            if (existing) existing.remove();
        } else if (!existing) {
            const button = document.createElement('div');
            button.className = 'mes_button bl-diff-btn bl-diff-btn-top fa-solid fa-clock-rotate-left interactable';
            button.title = '溯源净化前文';
            button.setAttribute('data-index', String(index));
            button.setAttribute('tabindex', '0');
            button.setAttribute('role', 'button');
            const editBtn = buttonArea.querySelector('.mes_edit');
            if (editBtn) buttonArea.insertBefore(button, editBtn);
            else buttonArea.appendChild(button);
        } else {
            existing.setAttribute('data-index', String(index));
        }
    }

    const swipeBlock = messageNode.querySelector('.swipeRightBlock');
    if (swipeBlock) {
        const existingBottom = swipeBlock.querySelector('.bl-diff-btn-bottom');
        if (!isEnabled || !hasSnippets) {
            if (existingBottom) existingBottom.remove();
        } else if (!existingBottom) {
            const btnBottom = document.createElement('div');
            btnBottom.className = 'swipe_right bl-diff-btn bl-diff-btn-bottom fa-solid fa-clock-rotate-left interactable';
            btnBottom.title = '溯源净化前文 (尾部触发)';
            btnBottom.setAttribute('data-index', String(index));
            btnBottom.setAttribute('tabindex', '0');
            btnBottom.setAttribute('role', 'button');
            btnBottom.style.marginTop = '10px';
            swipeBlock.appendChild(btnBottom);
        } else {
            existingBottom.setAttribute('data-index', String(index));
        }
    }
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
            if (Number.isInteger(n) && n >= 0) {
                index = n;
                break;
            }
        }
        if (index < 0) index = i;
        ensureMessageDiffButton(index, node);
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

export function isProtectedNode(node) {
    if (!node || !node.closest) return false;
    if (node.closest('#bl-purifier-popup, #bl-batch-popup, #bl-confirm-modal, #bl-rule-edit-modal, #bl-rule-transfer-modal, #bl-diff-modal')) return true;
    if (node.closest('#advanced_formatting, #api_settings')) return true;
    if ((node.id && node.id.includes('shujuku_v120-')) || node.closest('[id*="shujuku_v120-"]')) return true;

    const promptIds = [
        'system_prompt', 'post_history_prompt', 'floating_prompt', 'nsfw_prompt', 'author_note', 'jailbreak_prompt',
        'chat_completions_system_prompt', 'chat_completions_jailbreak_prompt', 'completion_prompt_manager_popup_entry_form_prompt',
        'completion_prompt_manager_popup_entry_form_name', 'description_textarea', 'personality_textarea', 'scenario_textarea',
        'mes_example_textarea', 'first_mes_textarea', 'creator_notes_textarea'
    ];
    if (node.id && promptIds.includes(node.id)) return true;
    if (node.id && node.id.startsWith('world_entry_content_')) return true;
    const dataFor = typeof node.getAttribute === 'function' ? node.getAttribute('data-for') : '';
    if (dataFor && dataFor.startsWith('world_entry_content_')) return true;
    if (node.tagName === 'TEXTAREA' && node.name === 'comment') return true;
    return false;
}

export function shouldSkipDbExtensionField(pathKeys = [], isGlobalSettings = false) {
    if (!isGlobalSettings || pathKeys.length < 2) return false;
    const rootNamespace = String(pathKeys[0] || '');
    if (!rootNamespace.includes('shujuku_v120')) return false;
    const currentKey = String(pathKeys[pathKeys.length - 1] || '');
    return /(Prompt|Settings|Template)/.test(currentKey);
}

function shouldSkipDbExtensionFieldByMeta(depth, rootNamespace, currentKey, isGlobalSettings = false) {
    if (!isGlobalSettings || depth < 2) return false;
    const rootNs = String(rootNamespace || '');
    if (!rootNs.includes('shujuku_v120')) return false;
    const key = String(currentKey || '');
    return /(Prompt|Settings|Template)/.test(key);
}

export function deepCleanObjectSync(rootObj) {
    if (!rootObj || typeof rootObj !== 'object') return 0;
    let changes = 0;
    const stack = [rootObj];
    const seen = new Set();

    while (stack.length > 0) {
        const current = stack.pop();
        if (!current || seen.has(current)) continue;
        seen.add(current);

        for (let key in current) {
            if (!Object.prototype.hasOwnProperty.call(current, key)) continue;
            const val = current[key];
            if (typeof val === 'string') {
                const cleaned = applyReplacements(val);
                if (cleaned !== val) {
                    current[key] = cleaned;
                    changes++;
                }
            } else if (val && typeof val === 'object') {
                stack.push(val);
            }
        }
    }
    return changes;
}

export async function safeDeepScrub(rootObj, isGlobalSettings = false, options = {}) {
    let changes = 0;
    if (!rootObj || typeof rootObj !== 'object') return changes;
    const stack = [{ node: rootObj, depth: 0, rootNamespace: '' }];
    const seen = new Set();
    buildProcessors();

    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const deadline = Number.isFinite(options.deadline) ? options.deadline : Infinity;
    let iterations = 0;

    while (stack.length > 0) {
        if (Date.now() > deadline) throw new Error('DEEP_CLEAN_TIMEOUT');

        if (++iterations % 500 === 0) {
            if (onProgress) onProgress({ visited: seen.size, pending: stack.length, changes });
            await new Promise(r => setTimeout(r, 0));
        }

        const currentItem = stack.pop();
        const current = currentItem?.node;
        const depth = currentItem?.depth || 0;
        const rootNamespace = currentItem?.rootNamespace || '';
        if (!current || seen.has(current)) continue;
        seen.add(current);

        try {
            for (let key in current) {
                if (Object.prototype.hasOwnProperty.call(current, key)) {
                    if (isGlobalSettings && key === extensionName) continue;
                    const nextDepth = depth + 1;
                    const nextRootNamespace = depth === 0 ? key : rootNamespace;
                    if (shouldSkipDbExtensionFieldByMeta(nextDepth, nextRootNamespace, key, isGlobalSettings)) continue;
                    const val = current[key];
                    if (typeof val === 'string') {
                        const cleaned = applyReplacements(val);
                        if (val !== cleaned) {
                            current[key] = cleaned;
                            changes++;
                        }
                    } else if (val !== null && typeof val === 'object') {
                        stack.push({ node: val, depth: nextDepth, rootNamespace: nextRootNamespace });
                    }
                }
            }
        } catch (e) { }
    }

    if (onProgress) onProgress({ visited: seen.size, pending: stack.length, changes });
    return changes;
}

export function getDeepCleanTimeoutMs() {
    const { extension_settings } = getAppContext();
    const raw = Number(extension_settings[extensionName]?.deepCleanTimeoutSec);
    const safeSeconds = Number.isFinite(raw) ? Math.min(Math.max(raw, 10), 1800) : defaultSettings.deepCleanTimeoutSec;
    return safeSeconds * 1000;
}

export async function performDeepCleanse() {
    const { chat, chat_metadata, extension_settings, saveChat, saveSettingsDebounced } = getAppContext();
    buildProcessors();
    if (runtimeState.activeProcessors.length === 0) {
        alert('没有开启的屏蔽规则，无需清理。');
        return;
    }

    showDeepCleanOverlay();
    await new Promise(r => setTimeout(r, 100));

    try {
        let scrubbedItems = 0;
        const timeoutMs = getDeepCleanTimeoutMs();
        const startAt = Date.now();
        const deadline = startAt + timeoutMs;

        const phases = [];
        if (chat && Array.isArray(chat)) phases.push({ label: '聊天记录', root: chat, isGlobalSettings: false });
        if (typeof chat_metadata === 'object' && chat_metadata !== null) phases.push({ label: '聊天元数据', root: chat_metadata, isGlobalSettings: false });
        if (typeof extension_settings === 'object' && extension_settings !== null) phases.push({ label: '插件设置', root: extension_settings, isGlobalSettings: true });
        if (typeof window.characters !== 'undefined' && Array.isArray(window.characters)) phases.push({ label: '角色卡', root: window.characters, isGlobalSettings: false });
        if (typeof window.world_info !== 'undefined' && window.world_info !== null) phases.push({ label: '世界书', root: window.world_info, isGlobalSettings: false });
        if (typeof window.power_user !== 'undefined' && window.power_user !== null && window.power_user.personas) phases.push({ label: '人设', root: window.power_user.personas, isGlobalSettings: false });

        for (let i = 0; i < phases.length; i++) {
            const phase = phases[i];
            const phaseBase = i / phases.length;
            const phaseSpan = 1 / phases.length;

            scrubbedItems += await safeDeepScrub(phase.root, phase.isGlobalSettings, {
                deadline,
                onProgress: ({ visited, pending, changes }) => {
                    const elapsed = ((Date.now() - startAt) / 1000).toFixed(1);
                    const dynamic = (visited + pending > 0) ? (visited / (visited + pending)) : 0;
                    updateDeepCleanOverlay(
                        phaseBase + dynamic * phaseSpan,
                        `正在清理 ${phase.label}（已扫描 ${visited}，剩余队列 ${pending}，命中 ${changes}）｜耗时 ${elapsed}s / 超时 ${Math.round(timeoutMs / 1000)}s`
                    );
                }
            });

            updateDeepCleanOverlay((i + 1) / phases.length, `已完成 ${phase.label}，准备进入下一阶段...`);
        }

        updateDeepCleanOverlay(0.97, '正在同步数据到磁盘，请稍候。');

        if (scrubbedItems > 0) {
            const saveChatPromise = saveChat();
            if (saveChatPromise instanceof Promise) await saveChatPromise;

            saveSettingsDebounced();
            const remainingMs = Math.max(300, Math.min(2000, deadline - Date.now()));
            await new Promise(r => setTimeout(r, remainingMs));

            updateDeepCleanOverlay(1, '清理完成，正在准备刷新页面...');
            await new Promise(r => setTimeout(r, 180));
            $('#bl-loading-overlay').remove();

            alert(`清理完成，共处理 ${scrubbedItems} 处匹配项。\n\n页面即将刷新，请在刷新后将系统预设切换回常用预设！`);
            location.reload();
        } else {
            updateDeepCleanOverlay(1, '未发现残留，任务结束。');
            await new Promise(r => setTimeout(r, 260));
            $('#bl-loading-overlay').remove();
            alert('未发现需要替换的数据残留。');
        }
    } catch (e) {
        console.error('[Ultimate Purifier] 深度清理出错:', e);
        $('#bl-loading-overlay').remove();
        if (e && e.message === 'DEEP_CLEAN_TIMEOUT') {
            const timeoutSec = Math.round(getDeepCleanTimeoutMs() / 1000);
            alert(`清理超时（${timeoutSec}s）已自动中止。\n建议减少规则范围或调大 deepCleanTimeoutSec 后重试。`);
        } else {
            alert('清理失败，请查看控制台。');
        }
    }
}

export function purifyDOM(rootNode) {
    if (!rootNode) return;
    buildProcessors();
    if (runtimeState.activeProcessors.length === 0) return;

    const walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_COMMENT, null, false);

    let node;
    while (node = walker.nextNode()) {
        const parent = node.parentNode;
        if (parent && (isProtectedNode(parent) || (document.activeElement && (document.activeElement === parent || parent.contains(document.activeElement))))) continue;

        const original = node.nodeValue || '';
        const nextValue = runtimeState.isStreamingGeneration ? applyVisualMask(original) : applyReplacements(original, { deterministic: true });
        if (original !== nextValue) node.nodeValue = nextValue;
    }

    if (rootNode.nodeType === 1) {
        if (rootNode.matches && rootNode.matches('input, textarea')) {
            const input = rootNode;
            if (!(isProtectedNode(input) || document.activeElement === input)) {
                const originalVal = input.value || '';
                const nextVal = runtimeState.isStreamingGeneration ? applyVisualMask(originalVal) : applyReplacements(originalVal, { deterministic: true });
                if (originalVal !== nextVal) input.value = nextVal;
            }
        }

        if (rootNode.querySelectorAll) {
            const inputs = rootNode.querySelectorAll('input, textarea');
            for (let i = 0; i < inputs.length; i++) {
                const input = inputs[i];
                if (isProtectedNode(input) || document.activeElement === input) continue;
                const originalVal = input.value || '';
                const nextVal = runtimeState.isStreamingGeneration ? applyVisualMask(originalVal) : applyReplacements(originalVal, { deterministic: true });
                if (originalVal !== nextVal) input.value = nextVal;
            }
        }
    }
}

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

export function getLatestMessageIndex() {
    const { chat } = getAppContext();
    return Array.isArray(chat) && chat.length > 0 ? chat.length - 1 : -1;
}

export function getMessageDomNode(index) {
    const chatEl = document.getElementById('chat');
    if (!chatEl) return null;
    const selectors = [`.mes[mesid="${index}"]`, `.mes[data-mesid="${index}"]`, `.mes[messageid="${index}"]`, `.mes[data-message-id="${index}"]`];
    for (const selector of selectors) {
        const node = chatEl.querySelector(selector);
        if (node) return node;
    }
    const allMes = chatEl.querySelectorAll('.mes');
    return allMes.length > 0 ? allMes[allMes.length - 1] : null;
}

export function cleanseMessageDataAtIndex(index) {
    const { chat } = getAppContext();
    if (!Array.isArray(chat) || index < 0 || index >= chat.length) return false;
    const msg = chat[index];
    if (!msg || typeof msg !== 'object') return false;
    let changed = false;
    const allSnippets = [];
    let mainFullDiff = "";

    if (typeof msg.mes === 'string') {
        const { cleanedText, snippets: mesSnippets, fullDiff } = buildDiffSnippetsFromText(msg.mes);
        allSnippets.push(...mesSnippets);
        mainFullDiff = fullDiff;
        if (cleanedText !== msg.mes) {
            msg.mes = cleanedText;
            changed = true;
        }
    }

    if (Array.isArray(msg.swipes)) {
        for (let i = 0; i < msg.swipes.length; i++) {
            if (typeof msg.swipes[i] === 'string') {
                const { cleanedText, snippets: swipeSnippets } = buildDiffSnippetsFromText(msg.swipes[i]);
                allSnippets.push(...swipeSnippets);
                if (cleanedText !== msg.swipes[i]) {
                    msg.swipes[i] = cleanedText;
                    changed = true;
                }
            } else if (msg.swipes[i] && typeof msg.swipes[i] === 'object' && typeof msg.swipes[i].mes === 'string') {
                const { cleanedText, snippets: swipeObjSnippets } = buildDiffSnippetsFromText(msg.swipes[i].mes);
                allSnippets.push(...swipeObjSnippets);
                if (cleanedText !== msg.swipes[i].mes) {
                    msg.swipes[i].mes = cleanedText;
                    changed = true;
                }
            }
        }
    }

    updateDiffSnippetCache(index, { snippets: allSnippets, fullDiff: mainFullDiff });
    return changed;
}


export function performIncrementalCleanse(payload, options = {}) {
    const { chat } = getAppContext();
    buildProcessors();
    if (runtimeState.activeProcessors.length === 0) return;

    const fallbackLatest = options.fallbackLatest !== false;
    let index = getMessageIndexFromEvent(payload);
    if (index < 0 && fallbackLatest) index = getLatestMessageIndex();
    if (index < 0) return;

    const dataChanged = options.visualOnly ? false : cleanseMessageDataAtIndex(index);
    const messageNode = getMessageDomNode(index);
    if (messageNode) {
        purifyDOM(messageNode);
        ensureMessageDiffButton(index, messageNode);
    }

    if (dataChanged) {
        try {
            if (typeof updateMessageBlock === 'function') updateMessageBlock(index, chat[index]);
        } catch (e) { }
        queueIncrementalChatSave();
    }
}

export function performGlobalCleanse() {
    const { chat, saveChat } = getAppContext();
    buildProcessors();
    if (runtimeState.activeProcessors.length === 0) {
        clearDiffSnippetsCache();
        injectDiffButtons();
        return;
    }
    let chatChanged = false;
    clearDiffSnippetsCache();

    if (chat && Array.isArray(chat)) {
        chat.forEach((msg, index) => {
            let msgChanged = false;
            const allSnippets = [];
            let mainFullDiff = "";

            if (typeof msg.mes === 'string') {
                const { cleanedText, snippets: mesSnippets, fullDiff } = buildDiffSnippetsFromText(msg.mes);
                allSnippets.push(...mesSnippets);
                mainFullDiff = fullDiff;
                if (msg.mes !== cleanedText) {
                    msg.mes = cleanedText;
                    msgChanged = true;
                }
            }

            if (msg.swipes && Array.isArray(msg.swipes)) {
                for (let i = 0; i < msg.swipes.length; i++) {
                    if (typeof msg.swipes[i] === 'string') {
                        const { cleanedText, snippets: swipeSnippets } = buildDiffSnippetsFromText(msg.swipes[i]);
                        allSnippets.push(...swipeSnippets);
                        if (msg.swipes[i] !== cleanedText) {
                            msg.swipes[i] = cleanedText;
                            msgChanged = true;
                        }
                    } else if (typeof msg.swipes[i] === 'object' && msg.swipes[i] !== null && typeof msg.swipes[i].mes === 'string') {
                        const { cleanedText, snippets: swipeObjSnippets } = buildDiffSnippetsFromText(msg.swipes[i].mes);
                        allSnippets.push(...swipeObjSnippets);
                        if (msg.swipes[i].mes !== cleanedText) {
                            msg.swipes[i].mes = cleanedText;
                            msgChanged = true;
                        }
                    }
                }
            }

            updateDiffSnippetCache(index, { snippets: allSnippets, fullDiff: mainFullDiff });

            if (msgChanged) {
                chatChanged = true;
                try {
                    if (typeof updateMessageBlock === 'function') setTimeout(() => updateMessageBlock(index, chat[index]), 50);
                } catch (e) { }
            }
        });

        const latestMsg = chat.length > 0 ? chat[chat.length - 1] : null;
        if (latestMsg && typeof latestMsg === 'object') {
            ['TavernDB_ACU_Data', 'TavernDB_ACU_SummaryData'].forEach((dbKey) => {
                const dbVal = latestMsg[dbKey];
                if (dbVal && typeof dbVal === 'object') {
                    const dbChanges = deepCleanObjectSync(dbVal);
                    if (dbChanges > 0) chatChanged = true;
                }
            });
        }
    }

    if (chatChanged) {
        try {
            if (typeof saveChat === 'function') saveChat();
        } catch (e) {
            console.error("[Ultimate Purifier] 存盘失败", e);
        }
    }
    purifyDOM(document.getElementById('chat'));
    injectDiffButtons();
}
