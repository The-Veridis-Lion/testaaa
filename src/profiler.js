// --- 轻量级性能探针 (Profiler) ---
export const VeridisProfiler = {
    stats: {},
    isActive: true, // 调试完毕后可以改成 false 关闭
    lastUIUpdate: 0,

    // 1. 开始计时
    start(label) {
        if (!this.isActive) return;
        if (!this.stats[label]) {
            this.stats[label] = { total: 0, calls: 0, max: 0, startTime: 0 };
        }
        this.stats[label].startTime = performance.now();
    },

    // 2. 结束计时并累计
    end(label) {
        if (!this.isActive || !this.stats[label] || !this.stats[label].startTime) return;
        const cost = performance.now() - this.stats[label].startTime;
        this.stats[label].total += cost;
        this.stats[label].calls += 1;
        if (cost > this.stats[label].max) this.stats[label].max = cost;
        this.stats[label].startTime = 0;

        // 👇 新增：把历史卡顿记录打印到控制台
        // 如果在你的电脑上单次执行超过 2 毫秒，就记入历史档案！
        if (cost > 2.0) {
            console.warn(`[Veridis 历史探针] 🚨 ${label} 出现耗时峰值: ${cost.toFixed(2)} ms (发生在第 ${this.stats[label].calls} 次调用)`);
        }
        
        // 节流更新 UI（每 1.5 秒刷新一次面板，绝不卡顿）
        if (performance.now() - this.lastUIUpdate > 1500) {
            this.updateUI();
            this.lastUIUpdate = performance.now();
        }
    },

    // 3. 渲染悬浮窗
    updateUI() {
        let panel = document.getElementById('veridis-profiler-panel');
        if (!panel) {
            panel = document.createElement('div');
            panel.id = 'veridis-profiler-panel';
            panel.style.cssText = `
                position: fixed; top: 10px; right: 10px; z-index: 9999999;
                background: rgba(0,0,0,0.8); color: #0f0; font-family: monospace;
                padding: 10px; border-radius: 8px; font-size: 12px; pointer-events: none;
                white-space: pre; border: 1px solid #333;
            `;
            document.body.appendChild(panel);
        }

        let html = '🚀 Veridis 性能探针 (1.5s刷新)\n';
        html += '---------------------------------\n';
        
        // 读取内存 (仅限 Chrome/Edge/SillyTavern 桌面端环境有效)
        if (performance.memory) {
            const usedMB = (performance.memory.usedJSHeapSize / 1048576).toFixed(1);
            const limitMB = (performance.memory.jsHeapSizeLimit / 1048576).toFixed(0);
            html += `🧠 JS内存: ${usedMB} MB / ${limitMB} MB\n`;
        }

        html += '---------------------------------\n';
        html += '[模块]       | 平均(ms) | 峰值(ms) | 调用次\n';

        for (const [label, data] of Object.entries(this.stats)) {
            if (data.calls === 0) continue;
            const avg = (data.total / data.calls).toFixed(2);
            const max = data.max.toFixed(1);
            const padLabel = label.padEnd(10, ' ');
            const padAvg = avg.padStart(8, ' ');
            const padMax = max.padStart(8, ' ');
            const padCalls = String(data.calls).padStart(6, ' ');
            html += `${padLabel} | ${padAvg} | ${padMax} | ${padCalls}\n`;
        }

        panel.textContent = html;
    }
};
