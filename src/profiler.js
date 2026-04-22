/**
 * Veridis 性能探针 (方案一：隐藏后门版)
 * 功能：记录代码执行耗时，平时隐藏，通过控制台指令 toggleVP() 唤起。
 */

const stats = {};
let isPanelVisible = false;

export const VeridisProfiler = {
    /**
     * 开始计时
     * @param {string} label 计时标签
     */
    start: function(label) {
        stats[label] = { start: performance.now() };
    },

    /**
     * 结束计时并记录
     * @param {string} label 计时标签
     */
    end: function(label) {
        if (!stats[label]) return;
        const duration = performance.now() - stats[label].start;
        stats[label].duration = duration;
        
        // 只有在面板可见时，才去刷新 UI
        if (isPanelVisible) {
            this.updateUI();
        }
    },

    /**
     * 初始化探针 UI 面板 (默认隐藏)
     */
    initUI: function() {
        if (document.getElementById('bl-profiler-panel')) return;

        const panel = document.createElement('div');
        panel.id = 'bl-profiler-panel';
        // 核心样式：初始状态为 display: none
        panel.setAttribute('style', `
            position: fixed;
            top: 10px;
            right: 10px;
            width: 240px;
            background: rgba(0, 0, 0, 0.85);
            color: #00ff00;
            padding: 12px;
            border-radius: 8px;
            font-family: 'Consolas', 'Monaco', monospace;
            font-size: 12px;
            z-index: 1000000;
            pointer-events: none;
            border: 1px solid #333;
            box-shadow: 0 4px 12px rgba(0,0,0,0.5);
            display: none; 
        `);

        panel.innerHTML = `
            <div style="border-bottom: 1px solid #444; padding-bottom: 5px; margin-bottom: 8px; font-weight: bold;">
                🛡️ Veridis 性能探针
            </div>
            <div id="bl-profiler-content">等待数据...</div>
            <div style="margin-top: 8px; color: #888; font-size: 10px;">控制台输入 toggleVP() 隐藏</div>
        `;

        document.body.appendChild(panel);
    },

    /**
     * 刷新面板内容
     */
    updateUI: function() {
        const contentEl = document.getElementById('bl-profiler-content');
        if (!contentEl) return;

        let html = '';
        for (const [label, data] of Object.entries(stats)) {
            if (data.duration !== undefined) {
                const color = data.duration > 16 ? '#ff4444' : '#00ff00'; // 超过 16ms (一帧) 变红
                html += `<div style="display:flex; justify-content:space-between; margin-bottom:4px;">
                            <span>${label}:</span>
                            <span style="color: ${color}">${data.duration.toFixed(2)} ms</span>
                         </div>`;
            }
        }
        contentEl.innerHTML = html;
    }
};

/**
 * 挂载到 window，作为 F12 控制台后门
 */
window.toggleVP = () => {
    const panel = document.getElementById('bl-profiler-panel');
    if (!panel) {
        // 如果还没初始化，先初始化一次
        VeridisProfiler.initUI();
        return window.toggleVP();
    }

    if (panel.style.display === 'none') {
        panel.style.display = 'block';
        isPanelVisible = true;
        console.log('%c[Ultimate Purifier] 🚀 性能探针已开启', 'color: #00ff00; font-weight: bold;');
    } else {
        panel.style.display = 'none';
        isPanelVisible = false;
        console.log('%c[Ultimate Purifier] 💤 性能探针已隐藏', 'color: #888;');
    }
};

// 页面加载完成后自动初始化 UI (但保持隐藏)
if (document.readyState === 'complete') {
    VeridisProfiler.initUI();
} else {
    window.addEventListener('load', () => VeridisProfiler.initUI());
}
