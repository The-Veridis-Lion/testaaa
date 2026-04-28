import { extensionName, getAppContext, runtimeState } from './state.js';
import { logger } from './log.js';
import { deepClone, getCurrentCharacterContext, getPresetForCharacter, parseInputToWords } from './utils.js';
import { performGlobalCleanse } from './core.js';
import { performDeepCleanse } from './cleanse.js';

export function setupUI() {
    logger.debug('[setupUI] 开始初始化 UI');
    $('#bl-purifier-popup, #bl-rule-edit-modal, #bl-confirm-modal, #bl-rule-transfer-modal, #bl-diff-modal, #bl-subrule-edit-modal').remove();

    if (!$('#bl-wand-btn').length) {
        $('#data_bank_wand_container').append(`
            <div id="bl-wand-btn" title="词汇映射管理">
                <i class="fa-solid fa-language fa-fw"></i><span>词汇映射</span>
            </div>`);
    }

    $('body').append(`
        <div id="bl-purifier-popup" data-bl-theme="auto" style="display:none;">
            <div class="header">
                <div class="title">
                    <i class="fas fa-globe"></i>
                    全局映射预设
                </div>
                <div class="icon-group">
                    <button id="bl-theme-toggle" title="切换主题"><i class="fas fa-circle-half-stroke"></i></button>
                    <button id="bl-default-toggle" title="设为默认预设" class="bl-bind-toggle"><i class="fas fa-star"></i></button>
                    <button id="bl-character-bind-toggle" title="将当前角色绑定到当前预设" class="bl-bind-toggle"><i class="fas fa-link-slash"></i></button>
                    <button id="bl-preset-import" title="导入存档"><i class="fas fa-file-import"></i></button>
                    <button id="bl-preset-export" title="导出存档"><i class="fas fa-file-export"></i></button>
                    <button id="bl-close-btn" title="关闭"><i class="fas fa-times"></i></button>
                </div>
            </div>

            <div class="toolbar">
                <select id="bl-preset-select" class="select-box"></select>
                <div class="icon-group">
                    <button id="bl-preset-rename" title="重命名"><i class="fas fa-pen"></i></button>
                    <button id="bl-preset-save" title="保存"><i class="fas fa-save"></i></button>
                    <button id="bl-preset-new" title="新建"><i class="fas fa-plus"></i></button>
                    <button id="bl-preset-delete" title="删除存档"><i class="fas fa-trash"></i></button>
                </div>
            </div>

            <div class="action-buttons">
                <button id="bl-open-new-rule-btn" class="btn-secondary"><i class="fas fa-folder-plus"></i> 新增规则分组</button>
                <button class="btn-secondary" id="bl-batch-toggle"><i class="fas fa-list-check"></i> 批量编辑模式</button>
            </div>

            <div class="batch-operations" id="bl-batch-operations">
                <button class="batch-btn" id="bl-btn-select-all"><i class="far fa-check-square"></i> 全选</button>
                <button class="batch-btn" id="bl-btn-select-invert"><i class="fas fa-minus-square"></i> 反选</button>
                <button class="batch-btn" id="bl-btn-batch-transfer"><i class="fas fa-copy"></i> 复制 / 转移</button>
                <button class="batch-btn danger" id="bl-btn-batch-delete"><i class="fas fa-trash"></i> 删除</button>
            </div>

            <div class="divider"></div>

            <div id="bl-tags-container" class="card-list" style="overflow-y:auto; flex:1;"></div>

            <div class="bottom-bar">
                <label class="checkbox-label" title="开启后，被修改过的消息旁会显示溯源按钮">
                    <input type="checkbox" id="bl-diff-global-toggle">
                    <span class="custom-checkbox square"></span>
                    <span class="bottom-text">透视模式</span>
                </label>
                <button id="bl-deep-clean-btn" class="btn-danger"><i class="fas fa-broom"></i> 深度清理</button>
            </div>
        </div>`);

    $('body').append(`
        <div id="bl-rule-edit-modal" class="bl-modal-shell">
            <div class="bl-modal-card bl-edit-modal-card">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; flex-shrink: 0;">
                    <h3 id="bl-edit-modal-title" class="bl-edit-modal-title" style="margin: 0; display: flex; align-items: center; gap: 8px;">
                        <i class="fas fa-pen"></i> 编辑规则合集
                    </h3>
                    <button id="bl-edit-cancel-x" class="bl-icon-btn" style="background: transparent !important; border: none !important; box-shadow: none !important; font-size: 20px !important; color: var(--text-mute); padding: 0 !important; min-width: auto !important; height: auto !important; cursor: pointer;">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
                <div class="bl-edit-field">
                    <label class="bl-field-label">规则组合集名称</label>
                    <input type="text" id="bl-edit-name" class="bl-input" placeholder="例如：程度副词与认知失能净化">
                </div>
                <label class="bl-field-label" style="margin-bottom:6px; flex-shrink:0;">映射规则列表</label>
                <div id="bl-edit-subrules-container"></div>
                
                <div class="bl-modal-actions">
                    <button id="bl-add-subrule-btn" class="bl-secondary-btn"><i class="fas fa-plus"></i> 新增规则</button>
                    <button id="bl-edit-save" class="bl-primary-btn"><i class="fas fa-check"></i> 保存合集</button>
                </div>
            </div>
        </div>
    `);

    $('body').append(`
        <div id="bl-confirm-modal" class="bl-modal-shell">
            <div class="bl-modal-card bl-confirm-card">
                <h3 class="bl-confirm-title">⚠️ 深度清理警告</h3>
                <p class="bl-confirm-text">
                    深度清理会永久洗刷角色卡、世界书、人设、全部历史记录及<strong>当前选中的预设</strong>。
                    为了防止深度清理修改或误伤您的以上内容，请在此刻：
                    <br><br>
                    👉 <strong class="bl-warning-callout">将SillyTavern当前的预设切换至「Default」或废弃预设！<br>将插件预设切换至不含名词句式规则(已在贴内提供)。</strong>
                    <br>
                    <span class="bl-field-label">清理完成后页面会刷新，届时可切回原预设即可保证预设安全。</span>
                </p>
                <div class="bl-modal-actions bl-confirm-actions">
                    <button id="bl-modal-cancel" class="bl-secondary-btn bl-confirm-btn">取消返回</button>
                    <button id="bl-modal-confirm" disabled class="bl-primary-btn bl-confirm-btn">我已阅读警告，已完成切换 (3s)</button>
                </div>
            </div>
        </div>
    `);

    $('body').append(`
        <div id="bl-rule-transfer-modal" style="display:none;">
            <div class="bl-transfer-content">
                <h3 class="bl-edit-modal-title bl-transfer-title"><i class="fas fa-copy"></i> 复制 / 转移规则合集</h3>
                <select id="bl-transfer-target" class="bl-input bl-transfer-target"></select>
                <div class="bl-transfer-actions">
                    <button id="bl-transfer-copy" class="bl-transfer-btn bl-transfer-copy">复制到该存档</button>
                    <button id="bl-transfer-move" class="bl-transfer-btn bl-transfer-move">转移到该存档</button>
                    <button id="bl-transfer-cancel" class="bl-transfer-btn">取消</button>
                </div>
            </div>
        </div>
    `);

    $('body').append(`
        <div id="bl-subrule-edit-modal" class="bl-modal-shell" style="z-index: 10000005;">
            <div class="bl-modal-card bl-edit-modal-card" style="padding: 20px !important;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; border-bottom: 1px dotted var(--border-dash); padding-bottom: 12px;">
                    <div style="position: relative; flex: 1; margin-right: 15px;">
                        <select id="bl-modal-sub-mode" class="bl-input" style="margin: 0; width: 100%; font-size: 16px !important; font-weight: bold; background-color: transparent !important; border: none !important; padding: 0 !important; color: var(--text-main) !important; appearance: none; -webkit-appearance: none;">
                            <option value="simple">🧩 简易组合 (推荐! 支持{}与*号)</option>
                            <option value="text">📝 普通文本 (长词优先替换)</option>
                            <option value="regex">⚙️ 正则表达式 (专业模式)</option>
                        </select>
                        <i class="fas fa-chevron-down" style="position: absolute; right: 0; top: 50%; transform: translateY(-50%); color: var(--text-mute); pointer-events: none; font-size: 14px;"></i>
                    </div>
                    <button id="bl-modal-sub-save" class="bl-icon-btn" style="background: transparent !important; border: none !important; color: var(--text-main) !important; font-size: 24px !important; padding: 0 5px !important; min-width: auto !important; height: auto !important;" title="完成保存"><i class="fas fa-check"></i></button>
                </div>
                
                <div class="bl-subrule-field" style="margin-bottom: 12px;">
                    <label class="bl-field-label" style="margin-bottom: 6px; font-weight: 600;">备注说明 (可选)</label>
                    <input type="text" id="bl-modal-sub-remark" class="bl-input" placeholder="例如：处理特定角色的口头禅" style="background: var(--bg-button) !important; border: none !important; border-radius: 8px !important; font-size: 14px !important; padding: 10px 14px !important;">
                </div>
                
                <div class="bl-subrule-field" style="margin-bottom: 12px;">
                    <label class="bl-field-label" style="margin-bottom: 6px; font-weight: 600;">查找内容</label>
                    <textarea id="bl-modal-sub-target" class="bl-textarea" rows="4" style="background: var(--bg-button) !important; border: none !important; border-radius: 8px !important; font-size: 14px !important; padding: 10px 14px !important;"></textarea>
                </div>
                
                <div class="bl-subrule-field" style="margin-bottom: 15px;">
                    <label class="bl-field-label" style="margin-bottom: 6px; font-weight: 600;">替换为</label>
                    <textarea id="bl-modal-sub-rep" class="bl-textarea" rows="4" style="background: var(--bg-button) !important; border: none !important; border-radius: 8px !important; font-size: 14px !important; padding: 10px 14px !important;"></textarea>
                </div>
                
                <button id="bl-modal-sub-cancel" class="bl-secondary-btn" style="margin-top: auto; border: none !important; background: var(--bg-button) !important;">取消修改</button>
            </div>
        </div>
    `);
} 

// (中间的 showDeepCleanOverlay, applyPresetByName 等函数保持不变，无需修改，直接保留即可)

export function renderSubrulesToModal() {
    const container = $('#bl-edit-subrules-container');
    container.empty();

    if (runtimeState.currentEditingSubrules.length === 0) {
        container.html('<div style="text-align:center; color:var(--bl-text-secondary); font-size:12px; padding:20px;">当前合集没有映射规则，请点击下方按钮添加。</div>');
        return;
    }

    runtimeState.currentEditingSubrules.forEach((sub, i) => {
        const mode = sub.mode || 'text';
        // 关键点：严格去除空格，判断是否真的有备注
        const remark = sub.remark ? sub.remark.trim() : '';
        const moveUpDisabled = i === 0 ? 'disabled' : '';
        const moveDownDisabled = i === runtimeState.currentEditingSubrules.length - 1 ? 'disabled' : '';

        const badgeBaseStyle = "display:inline-flex; align-items:center; justify-content:center; padding:3px 8px; border-radius:4px; font-size:11px; font-weight:800; color:#fff; min-width:40px; margin:0; line-height:1; flex-shrink:0;";
        let badgeHTML = '';
        if (mode === 'regex') badgeHTML = `<span style="${badgeBaseStyle} background:var(--bl-accent-color);">正则</span>`;
        else if (mode === 'simple') badgeHTML = `<span style="${badgeBaseStyle} background:color-mix(in srgb, var(--bl-accent-color) 72%, #3b82f6 28%);">简易</span>`;
        else badgeHTML = `<span style="${badgeBaseStyle} background:var(--bl-text-secondary); color:var(--bl-background-popup);">普通</span>`;

        let tPreview = sub.targets.join(mode === 'text' ? ', ' : ' | ');
        let rPreview = sub.replacements.join(', ');
        if (!rPreview) rPreview = '【直接删除】';

        // 没备注的时候直接为空（不渲染），完美收起
        let remarkHTML = '';
        if (remark) {
            remarkHTML = `
                <div style="margin-top: 8px; padding-top: 10px; border-top: 1px dashed var(--border-dash); font-size: 13px; color: var(--text-mute);">
                    备注: ${remark}
                </div>
            `;
        }

        container.append(`
            <div style="flex-shrink: 0 !important; background: var(--bl-background-secondary); border: 1px solid var(--bl-border-color); border-radius: 10px; padding: 12px 14px; margin-bottom: 12px; display: flex; flex-direction: column; box-shadow: 0 4px 10px rgba(0,0,0,0.04);">
                <div style="display: flex; justify-content: space-between; align-items: center; padding-bottom: 10px; margin-bottom: 10px; border-bottom: 1px dashed var(--border-dash);">
                    <div style="display: flex; align-items: center; margin: 0; padding: 0;">
                        ${badgeHTML}
                    </div>
                    <div style="display: flex; gap: 5px; align-items: center; margin: 0; padding: 0;">
                        <button class="bl-move-subrule-up-btn bl-icon-btn" data-index="${i}" title="上移" ${moveUpDisabled} style="margin:0;"><i class="fas fa-arrow-up"></i></button>
                        <button class="bl-move-subrule-down-btn bl-icon-btn" data-index="${i}" title="下移" ${moveDownDisabled} style="margin:0;"><i class="fas fa-arrow-down"></i></button>
                        <button class="bl-edit-subrule-btn bl-icon-btn" data-index="${i}" title="独立编辑" style="margin:0;"><i class="fas fa-pen"></i></button>
                        <button class="bl-del-subrule-btn bl-icon-btn" data-index="${i}" title="删除" style="margin:0;"><i class="fas fa-trash"></i></button>
                        <button class="bl-remark-subrule-btn bl-icon-btn" data-index="${i}" title="快捷备注" style="margin:0;"><i class="fas fa-comment-dots"></i></button>
                    </div>
                </div>
                <div style="font-size: 14px !important; color: var(--bl-text-primary); line-height: 1.5; word-break: break-all;">
                    ${tPreview}
                    <div style="margin-top: 4px;">→ ${rPreview}</div>
                </div>
                ${remarkHTML}
            </div>
        `);
    });
}
