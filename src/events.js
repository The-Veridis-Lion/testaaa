import { extensionName, getAppContext, runtimeState } from './state.js';
import { parseInputToWords, getCurrentCharacterContext } from './utils.js';
import {
    applyPresetByName,
    renderTags,
    updateToolbarUI,
    renderSubrulesToModal,
    showConfirmModal,
    refreshCharacterBindingUI,
    refreshVisualDiffToggleUI,
    applyCharacterPresetBinding,
    syncSubrulesFromDOM,
    openTransferModal,
    closeTransferModal,
    runRuleTransfer,
    openEditModal,
} from './ui.js';
import {
    buildProcessors,
    performDeepCleanse,
    performGlobalCleanse,
    purifyDOM,
    isProtectedNode,
    applyReplacements,
    applyVisualMask,
    performIncrementalCleanse,
    toggleVisualDiffMode,
    toggleVisualDiff,
    getLatestMessageIndex,
    clearVisualDiffCache,
} from './core.js';

export function initRealtimeInterceptor() {
    let isPurifying = false;

    const chatObserver = new MutationObserver((mutations) => {
        if (isPurifying) return;

        buildProcessors();
        if (runtimeState.activeProcessors.length === 0) return;

        isPurifying = true;
        try {
            for (let mi = 0; mi < mutations.length; mi++) {
                const m = mutations[mi];
                for (let ni = 0; ni < m.addedNodes.length; ni++) {
                    const node = m.addedNodes[ni];
                    if (node.nodeType === 3 || node.nodeType === 8) {
                        if (node.parentNode && isProtectedNode(node.parentNode)) continue;
                        const original = node.nodeValue;
                        const nextValue = runtimeState.isStreamingGeneration ? applyVisualMask(original) : applyReplacements(original, { deterministic: true });
                        if (original !== nextValue) node.nodeValue = nextValue;
                    } else if (node.nodeType === 1) {
                        purifyDOM(node);
                    }
                }
                if (m.type === 'characterData') {
                    if (m.target.parentNode && isProtectedNode(m.target.parentNode)) continue;
                    const original = m.target.nodeValue;
                    const nextValue = runtimeState.isStreamingGeneration ? applyVisualMask(original) : applyReplacements(original, { deterministic: true });
                    if (original !== nextValue) m.target.nodeValue = nextValue;
                }
            }
        } finally {
            chatObserver.takeRecords();
            isPurifying = false;
        }
    });

    const chatEl = document.getElementById('chat');
    if (chatEl) chatObserver.observe(chatEl, { childList: true, subtree: true, characterData: true });

    let currentTheaterShadow = null;
    const theaterIntervalId = setInterval(() => {
        const theaterHost = document.querySelector('#t-output-content .t-shadow-host');
        if (theaterHost && theaterHost.shadowRoot) {
            if (currentTheaterShadow !== theaterHost) {
                chatObserver.observe(theaterHost.shadowRoot, { childList: true, subtree: true, characterData: true });
                currentTheaterShadow = theaterHost;
                isPurifying = true;
                try {
                    purifyDOM(theaterHost.shadowRoot);
                } finally {
                    isPurifying = false;
                }
            }
        } else {
            currentTheaterShadow = null;
        }
    }, 800);
    window.addEventListener('beforeunload', () => clearInterval(theaterIntervalId), { once: true });

    document.addEventListener('input', (e) => {
        const el = e.target;
        if (!['TEXTAREA', 'INPUT'].includes(el.tagName)) return;
        if (isProtectedNode(el)) return;

        buildProcessors();
        if (runtimeState.activeProcessors.length === 0) return;

        const originalVal = el.value || '';
        const cleanedVal = applyReplacements(originalVal, { deterministic: true });

        if (originalVal !== cleanedVal) {
            const start = el.selectionStart;
            isPurifying = true;
            try {
                el.value = cleanedVal;
                try { el.setSelectionRange(start, start); } catch (err) { }
            } finally {
                isPurifying = false;
            }
        }
    }, true);
}

export function bindEvents() {
    const { extension_settings, saveSettingsDebounced, eventSource, event_types } = getAppContext();

    $(document).off('click', '#bl-wand-btn').on('click', '#bl-wand-btn', () => {
        updateToolbarUI();
        renderTags();
        $('#bl-purifier-popup').css('display', 'flex').hide().fadeIn(200);
    });

    $(document).off('click', '#bl-close-btn').on('click', '#bl-close-btn', () => $('#bl-purifier-popup').fadeOut(200));
    $(document).off('click', '#bl-visual-diff-toggle').on('click', '#bl-visual-diff-toggle', () => {
        const nextState = !runtimeState.isVisualDiffEnabled;
        toggleVisualDiffMode(nextState);
        if (!nextState) {
            clearVisualDiffCache();
        } else if (!runtimeState.isStreamingGeneration) {
            const latestIndex = getLatestMessageIndex();
            if (latestIndex >= 0) toggleVisualDiff(latestIndex, true);
        }
        refreshVisualDiffToggleUI();
    });
    $(document).off('click', '#bl-open-new-rule-btn').on('click', '#bl-open-new-rule-btn', () => openEditModal(-1));
    $(document).off('click', '.bl-rule-edit').on('click', '.bl-rule-edit', function() { openEditModal($(this).data('index')); });
    $(document).off('click', '.bl-rule-transfer').on('click', '.bl-rule-transfer', function() { openTransferModal($(this).data('index')); });

    $(document).off('change', '.bl-rule-toggle').on('change', '.bl-rule-toggle', function() {
        const index = $(this).data('index');
        extension_settings[extensionName].rules[index].enabled = $(this).prop('checked');
        runtimeState.isRegexDirty = true;
        saveSettingsDebounced();
        renderTags();
        performGlobalCleanse();
    });

    $(document).off('click', '.bl-rule-del').on('click', '.bl-rule-del', function() {
        extension_settings[extensionName].rules.splice($(this).data('index'), 1);
        runtimeState.isRegexDirty = true;
        saveSettingsDebounced();
        renderTags();
    });

    $(document).off('click', '#bl-add-subrule-btn').on('click', '#bl-add-subrule-btn', () => {
        syncSubrulesFromDOM();
        runtimeState.currentEditingSubrules.push({ targets: [], replacements: [], mode: 'simple', isEditing: true });
        renderSubrulesToModal();
        const container = $('#bl-edit-subrules-container');
        container.scrollTop(container[0].scrollHeight);
    });

    $(document).off('click', '.bl-edit-subrule-btn').on('click', '.bl-edit-subrule-btn', function() {
        syncSubrulesFromDOM();
        runtimeState.currentEditingSubrules[$(this).data('index')].isEditing = true;
        renderSubrulesToModal();
    });

    $(document).off('click', '.bl-save-subrule-btn').on('click', '.bl-save-subrule-btn', function() {
        syncSubrulesFromDOM();
        runtimeState.currentEditingSubrules[$(this).data('index')].isEditing = false;
        renderSubrulesToModal();
    });

    $(document).off('change', '.bl-sub-mode').on('change', '.bl-sub-mode', function() {
        const idx = $(this).closest('.bl-subrule-row').find('.bl-save-subrule-btn').data('index');
        syncSubrulesFromDOM();
        runtimeState.currentEditingSubrules[idx].mode = $(this).val();
        renderSubrulesToModal();
    });

    $(document).off('click', '.bl-del-subrule-btn').on('click', '.bl-del-subrule-btn', function() {
        syncSubrulesFromDOM();
        runtimeState.currentEditingSubrules.splice($(this).data('index'), 1);
        renderSubrulesToModal();
    });

    $(document).off('click', '#bl-edit-cancel').on('click', '#bl-edit-cancel', () => $('#bl-rule-edit-modal').hide());
    $(document).off('click', '#bl-transfer-cancel').on('click', '#bl-transfer-cancel', () => closeTransferModal());
    $(document).off('click', '#bl-transfer-copy').on('click', '#bl-transfer-copy', () => runRuleTransfer(false));
    $(document).off('click', '#bl-transfer-move').on('click', '#bl-transfer-move', () => runRuleTransfer(true));
    $(document).off('click', '#bl-rule-transfer-modal').on('click', '#bl-rule-transfer-modal', function(e) {
        if (e.target && e.target.id === 'bl-rule-transfer-modal') closeTransferModal();
    });

    $(document).off('click', '#bl-edit-save').on('click', '#bl-edit-save', () => {
        syncSubrulesFromDOM();
        const nameVal = $('#bl-edit-name').val().trim();

        const validSubrules = runtimeState.currentEditingSubrules.filter(sub => sub.targets.length > 0);
        if (validSubrules.length === 0) {
            alert("至少需要提供一组有效的目标词！(被替换词不能全空)");
            return;
        }

        validSubrules.forEach(sub => delete sub.isEditing);

        let isEnabled = true;
        if (runtimeState.currentEditingIndex !== -1) {
            isEnabled = extension_settings[extensionName].rules[runtimeState.currentEditingIndex].enabled !== false;
        }

        const newRule = {
            name: nameVal || `合集 ${extension_settings[extensionName].rules.length + 1}`,
            subRules: validSubrules,
            enabled: isEnabled
        };

        if (runtimeState.currentEditingIndex === -1) extension_settings[extensionName].rules.push(newRule);
        else extension_settings[extensionName].rules[runtimeState.currentEditingIndex] = newRule;

        runtimeState.isRegexDirty = true;
        saveSettingsDebounced();
        renderTags();
        performGlobalCleanse();
        $('#bl-rule-edit-modal').hide();
    });

    $(document).off('click', '#bl-deep-clean-btn').on('click', '#bl-deep-clean-btn', () => showConfirmModal(() => performDeepCleanse()));

    $(document).off('change', '#bl-preset-select').on('change', '#bl-preset-select', function() {
        applyPresetByName($(this).val(), { skipRender: true });
        renderTags();
        refreshCharacterBindingUI();
    });

    $(document).off('click', '#bl-default-toggle').on('click', '#bl-default-toggle', function() {
        const settings = extension_settings[extensionName];
        const activePreset = String(settings.activePreset || '');
        if (!activePreset) {
            alert('请先在下拉框中选择一个预设。');
            return;
        }
        settings.defaultPreset = settings.defaultPreset === activePreset ? "" : activePreset;
        saveSettingsDebounced();
        refreshCharacterBindingUI();
    });

    $(document).off('click', '#bl-character-bind-toggle').on('click', '#bl-character-bind-toggle', function() {
        const settings = extension_settings[extensionName];
        const activePreset = String(settings.activePreset || '');
        if (!activePreset) {
            alert('请先在下拉框中选择一个预设。');
            return;
        }
        const context = getCurrentCharacterContext();
        if (!context.key) {
            alert('当前页面未识别到可绑定角色。请进入单角色聊天后再绑定。');
            refreshCharacterBindingUI();
            return;
        }

        if (!settings.characterBindings) settings.characterBindings = {};
        const isCurrentlyBound = settings.characterBindings[context.key] === activePreset;
        if (isCurrentlyBound) delete settings.characterBindings[context.key];
        else settings.characterBindings[context.key] = activePreset;

        runtimeState.lastCharacterContextKey = context.key;
        if (!isCurrentlyBound) applyPresetByName(activePreset, { skipRender: true });
        else applyCharacterPresetBinding(true);

        saveSettingsDebounced();
        refreshCharacterBindingUI();
    });

    $(document).off('click', '#bl-preset-rename').on('click', '#bl-preset-rename', function() {
        const settings = extension_settings[extensionName];
        const oldName = settings.activePreset;
        if (!oldName) { alert("当前为临时规则，请先新建存档。"); return; }
        const newName = prompt("输入新存档名称：", oldName);
        if (!newName || newName === oldName) return;
        if (settings.presets[newName]) { alert("存档名称已存在。"); return; }
        settings.presets[newName] = settings.presets[oldName];
        delete settings.presets[oldName];
        if (settings.defaultPreset === oldName) settings.defaultPreset = newName;
        Object.keys(settings.characterBindings || {}).forEach((key) => {
            if (settings.characterBindings[key] === oldName) settings.characterBindings[key] = newName;
        });
        settings.activePreset = newName;
        saveSettingsDebounced();
        updateToolbarUI();
    });

    $(document).off('click', '#bl-preset-delete').on('click', '#bl-preset-delete', function() {
        const settings = extension_settings[extensionName];
        const name = settings.activePreset;
        if (!name) return;
        if (confirm(`确定删除存档 "${name}" 吗？`)) {
            delete settings.presets[name];
            if (settings.defaultPreset === name) settings.defaultPreset = "";
            Object.keys(settings.characterBindings || {}).forEach((key) => {
                if (settings.characterBindings[key] === name) delete settings.characterBindings[key];
            });
            settings.activePreset = "";
            settings.rules = [];
            runtimeState.isRegexDirty = true;
            saveSettingsDebounced();
            renderTags();
            updateToolbarUI();
            performGlobalCleanse();
        }
    });

    $(document).off('click', '#bl-preset-new').on('click', '#bl-preset-new', function() {
        const settings = extension_settings[extensionName];
        const name = prompt("输入新存档名称：");
        if (!name) return;
        if (settings.presets[name]) { alert("存档名称已存在。"); return; }
        settings.presets[name] = JSON.parse(JSON.stringify(settings.rules));
        settings.activePreset = name;
        saveSettingsDebounced();
        updateToolbarUI();
    });

    $(document).off('click', '#bl-preset-save').on('click', '#bl-preset-save', function() {
        const settings = extension_settings[extensionName];
        if (!settings.activePreset) { alert("当前为临时规则，请点击“新建”保存为新存档。"); return; }
        settings.presets[settings.activePreset] = JSON.parse(JSON.stringify(settings.rules));
        saveSettingsDebounced();
        alert("已保存到存档：" + settings.activePreset);
    });

    $(document).off('click', '#bl-preset-export').on('click', '#bl-preset-export', function() {
        const settings = extension_settings[extensionName];
        const data = JSON.stringify(settings.rules, null, 2);
        const blob = new Blob([data], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = (settings.activePreset || "临时规则") + ".json";
        a.click();
        URL.revokeObjectURL(url);
    });

    $(document).off('click', '#bl-preset-import').on('click', '#bl-preset-import', function() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = e => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = event => {
                try {
                    let importedRules = JSON.parse(event.target.result);
                    if (typeof importedRules === 'object' && !Array.isArray(importedRules) && importedRules.rules) {
                        importedRules = importedRules.rules;
                    }

                    if (!Array.isArray(importedRules)) throw new Error("格式非数组");

                    const defaultName = file.name.replace(/\.json$/i, '');
                    const newName = prompt("导入成功！\n输入存档名称直接保存，或点击取消仅作为临时规则预览：", defaultName);
                    const settings = extension_settings[extensionName];

                    importedRules.forEach((r, idx) => {
                        if (!r.name) r.name = r.targets?.[0] || `未命名合集 ${idx + 1}`;
                        if (r.enabled === undefined) r.enabled = true;
                        if (r.targets) {
                            r.subRules = [{ targets: r.targets, replacements: r.replacements || [], mode: 'text' }];
                            delete r.targets;
                            delete r.replacements;
                        }
                        if (!r.subRules) r.subRules = [];
                        r.subRules.forEach(sub => { if (!sub.mode) sub.mode = 'text'; });
                    });

                    settings.rules = importedRules;
                    if (newName) {
                        settings.presets[newName] = JSON.parse(JSON.stringify(importedRules));
                        settings.activePreset = newName;
                    } else {
                        settings.activePreset = "";
                    }

                    runtimeState.isRegexDirty = true;
                    saveSettingsDebounced();
                    renderTags();
                    updateToolbarUI();
                    performGlobalCleanse();
                } catch (err) {
                    alert("导入失败：检查文件是否为合法规则数组。");
                }
            };
            reader.readAsText(file);
        };
        input.click();
    });

    const visualMaskLatestOnly = (payload) => {
        if (!runtimeState.isStreamingGeneration) return;
        performIncrementalCleanse(payload, { visualOnly: true, fallbackLatest: true });
    };
    const delayedIncrementalCleanse = (payload) => {
        runtimeState.isStreamingGeneration = false;
        setTimeout(() => {
            performIncrementalCleanse(payload, { visualOnly: false, fallbackLatest: true });
            if (runtimeState.isVisualDiffEnabled) {
                const latestIndex = getLatestMessageIndex();
                if (latestIndex >= 0) toggleVisualDiff(latestIndex, true);
            }
        }, 120);
    };

    if (event_types.MESSAGE_EDITED) eventSource.on(event_types.MESSAGE_EDITED, (payload) => {
        setTimeout(() => performIncrementalCleanse(payload, { visualOnly: false, fallbackLatest: true }), 0);
    });
    if (event_types.GENERATION_STARTED) eventSource.on(event_types.GENERATION_STARTED, () => { runtimeState.isStreamingGeneration = true; });
    if (event_types.STREAM_TOKEN_RECEIVED) {
        eventSource.on(event_types.STREAM_TOKEN_RECEIVED, (payload) => {
            runtimeState.isStreamingGeneration = true;
            visualMaskLatestOnly(payload);
        });
    }
    if (event_types.GENERATION_ENDED) eventSource.on(event_types.GENERATION_ENDED, delayedIncrementalCleanse);
    if (event_types.GENERATION_STOPPED) eventSource.on(event_types.GENERATION_STOPPED, delayedIncrementalCleanse);
    if (event_types.MESSAGE_RECEIVED) eventSource.on(event_types.MESSAGE_RECEIVED, delayedIncrementalCleanse);
    if (event_types.MESSAGE_SWIPED) eventSource.on(event_types.MESSAGE_SWIPED, delayedIncrementalCleanse);
    if (event_types.MESSAGE_RECEIVED) eventSource.on(event_types.MESSAGE_RECEIVED, () => {
        runtimeState.isVisualDiffEnabled = false;
        clearVisualDiffCache();
        refreshVisualDiffToggleUI();
    });
    if (event_types.CHAT_CHANGED) {
        eventSource.on(event_types.CHAT_CHANGED, () => {
            runtimeState.isVisualDiffEnabled = false;
            clearVisualDiffCache();
            refreshVisualDiffToggleUI();
            applyCharacterPresetBinding(true);
            setTimeout(performGlobalCleanse, 120);
        });
    }

    setInterval(() => applyCharacterPresetBinding(false), 1200);
}
