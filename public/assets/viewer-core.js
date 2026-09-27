// 轴/场景范围：包含原点与全部轨迹点，供坐标轴与相机取景共用。
function axisExtents(data) {
    const max = [0.1, 0.1, 0.1], min = [0, 0, 0];
    for (const arm of ['left', 'right']) {
        for (const point of data[arm] || []) {
            for (let axis = 0; axis < 3; axis++) {
                const value = point[axis];
                if (!Number.isFinite(value)) continue;
                max[axis] = Math.max(max[axis], value);
                min[axis] = Math.min(min[axis], value);
            }
        }
    }
    return {
        x0: Math.min(0, min[0]) * 1.05, x1: Math.max(0.1, max[0]) * 1.05,
        y0: Math.min(0, min[1]) * 1.05, y1: Math.max(0.1, max[1]) * 1.05,
        z0: Math.min(0, min[2]) * 1.05, z1: Math.max(0.1, max[2]) * 1.05,
    };
}

function sceneBounds(data) {
    const e = axisExtents(data);
    return { x: [e.x0, e.x1], y: [e.y0, e.y1], z: [e.z0, e.z1] };
}

function trajectoryCentroid(data) {
    let n = 0, sum = [0, 0, 0];
    for (const arm of ['left', 'right']) {
        if (data.single_arm && arm === 'right') continue;
        for (const point of data[arm] || []) {
            if (!point.every(Number.isFinite)) continue;
            sum[0] += point[0]; sum[1] += point[1]; sum[2] += point[2];
            n += 1;
        }
    }
    return n ? sum.map(value => value / n) : [0, 0, 0];
}

// Plotly 相机坐标是包围盒归一化域：盒子中心为 (0,0,0)，与数据原点无关。
function dataToCameraCenter(point, bounds) {
    const center = {};
    for (const axis of ['x', 'y', 'z']) {
        const lo = bounds[axis][0], hi = bounds[axis][1], span = Math.max(1e-6, hi - lo);
        const index = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
        center[axis] = 2 * (point[index] - (lo + hi) / 2) / span;
    }
    return center;
}

function leftRightDelta(data) {
    if (data.single_arm || !data.left.length || data.left.length !== data.right.length) return null;
    const delta = [0, 0, 0];
    let widest = [0, 0, 0], widestLength = 0;
    for (let i = 0; i < data.left.length; i++) {
        const difference = data.right[i].map((v, axis) => v - data.left[i][axis]);
        for (let axis = 0; axis < 3; axis++) delta[axis] += difference[axis] / data.left.length;
        const length = Math.hypot(difference[0], difference[1]);
        if (length > widestLength) { widestLength = length; widest = difference; }
    }
    const epsilon = Math.max(1e-9, widestLength * 1e-6);
    let horizontal = Math.hypot(delta[0], delta[1]);
    if (horizontal <= epsilon && widestLength > epsilon) {
        delta.splice(0, 3, ...widest);
        horizontal = widestLength;
    }
    return horizontal <= epsilon ? null : { delta, horizontal };
}

// 相机绕轨迹中心转，略拉远以便同时看到原点轴；保持 Z-up。
function trajectoryInitialCamera(data, bounds = sceneBounds(data)) {
    const center = dataToCameraCenter(trajectoryCentroid(data), bounds);
    const lr = leftRightDelta(data);
    const distance = 2.2;
    if (!lr) {
        return { eye: { x: center.x + distance * .72, y: center.y + distance * .72, z: center.z + distance * .55 }, up: { x: 0, y: 0, z: 1 }, center };
    }
    return {
        eye: {
            x: center.x + distance * lr.delta[1] / lr.horizontal,
            y: center.y - distance * lr.delta[0] / lr.horizontal,
            z: center.z + distance * .42,
        },
        up: { x: 0, y: 0, z: 1 },
        center,
    };
}

function presetCamera(name, data, bounds = sceneBounds(data)) {
    const center = dataToCameraCenter(trajectoryCentroid(data), bounds);
    const dist = 2.35;
    if (name === 'top') return { eye: { x: center.x, y: center.y, z: center.z + dist }, up: { x: 0, y: 1, z: 0 }, center };
    if (name === 'front') return { eye: { x: center.x, y: center.y - dist, z: center.z + .35 }, up: { x: 0, y: 0, z: 1 }, center };
    if (name === 'side') return { eye: { x: center.x + dist, y: center.y, z: center.z + .35 }, up: { x: 0, y: 0, z: 1 }, center };
    return trajectoryInitialCamera(data, bounds);
}

// 服务器版与公开版共用的显示与交互；数据读取由各自入口提供。
window.createTrajectoryViewer = function () {
const $ = id => document.getElementById(id);
const video = $('video'), scrub = $('scrub');
const videoGrid = $('video-grid'), videoSecondary = $('video-secondary'), videoLabelPrimary = $('video-label-primary');
const ARMS = { right: { name: '右臂', color: '#78a6d8', light: '#b8cff0', base: 0 }, left: { name: '左臂', color: '#c88768', light: '#e4ae92', base: 3 } }; // 本体左右语义。
const PLOT_CONFIG = {
    responsive: true, displaylogo: false, displayModeBar: true, scrollZoom: true,
    modeBarButtonsToRemove: ['toImage', 'sendDataToCloud', 'tableRotation', 'resetCameraLastSave3d'],
};
let d = null, cache = {}, ready = false, generation = 0, controller = null;
let work = Promise.resolve(), pendingFrame = null, rendering = false, lastFrame = -1, clock = null, armView = 'both';
let rotating = false; // 拖动相机时暂停轨迹 restyle，避免抢 WebGL。
let homeCamera = null, bounds = null, dragMode = 'turntable';
let secondaryVideos = []; // 副相机 <video>，跟随主视频时间。

let mediaRelease = null;
// 仅使用大于 0 的有限速度；首帧和全静止序列没有有效统计值。
function speedStats(values) {
    const a = values.filter(v => Number.isFinite(v) && v > 0).sort((x, y) => x - y);
    const mid = Math.floor(a.length / 2);
    return a.length ? { mean: a.reduce((s, v) => s + v, 0) / a.length, median: a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2 } : { mean: null, median: null };
}

// 统一消息出口，保留原页面的单行状态位置。
function message(text, error = false) {
    $('status').textContent = text;
    $('status').title = text;
    $('status').className = error ? 'error' : '';
}

// 只在图表和视频都准备好时开放控制。
function enable(value) {
    ready = value;
    video.controls = value;
    for (const el of [scrub, $('rateSelect'), ...document.querySelectorAll('[data-arm], [data-camera], [data-dragmode]')]) {
        if (el) el.disabled = !value;
    }
}

// Plotly 更新串行执行，换数据后旧任务自动失效。
function schedule(task, id = generation) {
    const result = work.then(() => id === generation ? task() : undefined);
    work = result.catch(error => { if (id === generation) { enable(false); video.pause(); message(error.message, true); } });
    return result;
}

// 等待任意 video 元素的 metadata，切换文件会取消旧等待。
function loadVideoElement(el, url, signal, label = '视频') {
    return new Promise((resolve, reject) => {
        const finish = error => {
            clearTimeout(timer);
            el.removeEventListener('loadedmetadata', loaded);
            el.removeEventListener('error', failed);
            signal.removeEventListener('abort', aborted);
            error ? reject(error) : resolve();
        };
        const loaded = () => finish();
        const failed = () => finish(new Error(`${label}无法加载或编码不受支持`));
        const aborted = () => finish(new DOMException('加载已取消', 'AbortError'));
        const timer = setTimeout(() => finish(new Error(`${label}加载超时`)), 30000);
        el.addEventListener('loadedmetadata', loaded);
        el.addEventListener('error', failed);
        signal.addEventListener('abort', aborted, { once: true });
        if (signal.aborted) { aborted(); return; }
        el.src = url;
        el.load();
    });
}

function clearSecondaryVideos() {
    for (const el of secondaryVideos) {
        el.pause();
        el.removeAttribute('src');
        el.load();
    }
    secondaryVideos = [];
    if (videoSecondary) videoSecondary.replaceChildren();
    if (videoGrid) videoGrid.dataset.count = '1';
    if (videoLabelPrimary) videoLabelPrimary.textContent = 'camera';
}

function syncSecondaryVideos(time = video.currentTime) {
    if (!secondaryVideos.length || !Number.isFinite(time)) return;
    const slack = d ? Math.max(1 / d.fps, 0.04) : 0.04;
    for (const el of secondaryVideos) {
        if (!Number.isFinite(el.duration) || el.seeking) continue;
        if (Math.abs(el.currentTime - time) > slack) {
            try { el.currentTime = Math.min(Math.max(0, time), Math.max(0, el.duration - 1e-3)); } catch {}
        }
    }
}

async function playSecondaryVideos() {
    for (const el of secondaryVideos) {
        try { el.muted = true; await el.play(); } catch {}
    }
}

function pauseSecondaryVideos() {
    for (const el of secondaryVideos) el.pause();
}

async function mountVideos(candidate, signal) {
    const list = Array.isArray(candidate.videos) && candidate.videos.length
        ? candidate.videos
        : [{ key: 'video', label: 'camera', url: candidate.video_url }];
    const primary = list[0];
    if (videoLabelPrimary) videoLabelPrimary.textContent = primary.label || primary.key || 'camera';
    await loadVideoElement(video, primary.url, signal, primary.label || '主相机');
    if (signal.aborted) throw new DOMException('加载已取消', 'AbortError');
    if (!Number.isFinite(video.duration) || Math.abs(video.duration - candidate.duration) > Math.max(.02, .5 / candidate.fps)) {
        throw new Error('主相机时长与轨迹不一致，无法同步播放');
    }
    const warnings = Array.isArray(candidate.warnings) ? candidate.warnings : (candidate.warnings = []);
    clearSecondaryVideos();
    const secondaries = list.slice(1);
    if (videoGrid) videoGrid.dataset.count = String(1 + secondaries.length);
    for (const item of secondaries) {
        const cell = document.createElement('div');
        cell.className = 'video-cell';
        const label = document.createElement('span');
        label.className = 'video-label';
        label.textContent = item.label || item.key || 'camera';
        const el = document.createElement('video');
        el.preload = 'metadata';
        el.muted = true;
        el.playsInline = true;
        el.setAttribute('playsinline', '');
        cell.append(label, el);
        videoSecondary.append(cell);
        try {
            await loadVideoElement(el, item.url, signal, label.textContent);
            if (signal.aborted) throw new DOMException('加载已取消', 'AbortError');
            if (!Number.isFinite(el.duration) || Math.abs(el.duration - candidate.duration) > Math.max(.02, .5 / candidate.fps)) {
                warnings.push(`${label.textContent} 时长与轨迹不一致，已跳过`);
                cell.remove();
                continue;
            }
            secondaryVideos.push(el);
        } catch (error) {
            if (error.name === 'AbortError') throw error;
            warnings.push(`${label.textContent} 加载失败，已跳过`);
            cell.remove();
        }
    }
    if (videoGrid) videoGrid.dataset.count = String(1 + secondaryVideos.length);
}

// 两种数据源进入同一加载流程；取消旧加载并统一释放本地视频 URL。
async function load(provider) {
    const id = ++generation, rate = Number($('rateSelect').value);
    controller?.abort();
    const request = controller = new AbortController();
    enable(false); video.pause(); pauseSecondaryVideos(); stopClock(); pendingFrame = null;
    video.removeAttribute('src'); video.load();
    clearSecondaryVideos();
    if (mediaRelease) { mediaRelease(); mediaRelease = null; }
    message('加载中…');
    const timer = setTimeout(() => request.abort(), 60000);
    let candidate;
    try {
        candidate = await provider(request.signal);
        if (id !== generation || request.signal.aborted) throw new DOMException('加载已取消', 'AbortError');
        mediaRelease = candidate.release || null;
        await mountVideos(candidate, request.signal);
        if (id !== generation) return;
        await schedule(async () => { d = candidate; prepare(); await draw(); }, id);
        if (id !== generation) return;
        lastFrame = -1; scrub.max = d.frames - 1; scrub.value = 0;
        video.playbackRate = rate;
        for (const el of secondaryVideos) el.playbackRate = rate;
        $('rateSelect').value = String(rate); enable(true);
        $('fps').textContent = `${d.fps} Hz`;
        syncSecondaryVideos(0);
        render(0);
        const camHint = secondaryVideos.length ? ` · ${1 + secondaryVideos.length} 路相机` : '';
        const taskHint = d.task ? ` · ${d.task}` : '';
        message(`episode ${d.episode} 已加载${camHint}${taskHint}${d.warnings.length ? ' · ' + d.warnings.join('；') : ''}`);
    } catch (error) {
        if (id === generation) {
            enable(false);
            showTaskPrompt('');
            video.removeAttribute('src'); video.load();
            clearSecondaryVideos();
            if (mediaRelease) { mediaRelease(); mediaRelease = null; }
            message(error.name === 'AbortError' ? '加载超时，请重试' : error.message, true);
        } else candidate?.release?.();
    } finally { clearTimeout(timer); }
}
function showTaskPrompt(task) {
    const bar = $('task-bar'), prompt = $('task-prompt');
    if (!bar || !prompt) return;
    const text = typeof task === 'string' ? task.trim() : '';
    prompt.textContent = text;
    bar.hidden = !text;
}

function axisTraces(data) {
    const e = axisExtents(data);
    const line = (x, y, z, color, label) => ({
        type: 'scatter3d', mode: 'lines+text', x, y, z,
        text: x.map((_, i) => i === x.length - 1 ? label : ''),
        textposition: 'top center',
        textfont: { size: 16, color, family: 'system-ui,sans-serif' },
        line: { color, width: 10 }, hoverinfo: 'skip', showlegend: false,
    });
    return [
        line([e.x0, 0, e.x1], [0, 0, 0], [0, 0, 0], '#e74c3c', 'X'),
        line([0, 0, 0], [e.y0, 0, e.y1], [0, 0, 0], '#2ecc71', 'Y'),
        line([0, 0, 0], [0, 0, 0], [e.z0, 0, e.z1], '#3498db', 'Z'),
        {
            type: 'scatter3d', mode: 'markers+text', x: [0], y: [0], z: [0],
            text: ['O'], textposition: 'bottom center',
            textfont: { size: 14, color: '#262421' },
            marker: { color: '#111', size: 7, line: { color: '#fff', width: 1 } },
            hovertemplate: 'origin (0, 0, 0)<extra></extra>', showlegend: false,
        },
    ];
}

function axisLayout(bounds) {
    const axis = (title, range) => ({
        title: { text: title }, range: range.slice(), autorange: false,
        zeroline: true, zerolinewidth: 2, zerolinecolor: '#9b8b7e',
        gridcolor: '#e4d9ce', showbackground: true, backgroundcolor: '#f7f1ea',
        showspikes: false,
    });
    return {
        xaxis: axis('X (m)', bounds.x),
        yaxis: axis('Y (m)', bounds.y),
        zaxis: axis('Z (m)', bounds.z),
    };
}

// 完整坐标和 hover 信息只计算一次，播放时复用。
function prepare() {
    cache = {};
    bounds = sceneBounds(d);
    homeCamera = trajectoryInitialCamera(d, bounds);
    showTaskPrompt(d.task);
    document.querySelector('.plot-toolbar > b').textContent = d.point_label || 'EE';
    const single = Boolean(d.single_arm);
    for (const id of ['right-x','right-y','right-z','right-v']) $(id).style.display = single ? 'none' : '';
    document.querySelectorAll('[data-arm="right"]').forEach(el => el.style.display = single ? 'none' : '');
    for (const arm of Object.keys(ARMS)) {
        const speeds = d[`${arm}_speed`];
        cache[arm] = { x: d[arm].map(p => p[0]), y: d[arm].map(p => p[1]), z: d[arm].map(p => p[2]), speeds, stats: speedStats(speeds),
            frames: Array.from({ length: d.frames }, (_, i) => i),
            custom: speeds.map((v, i) => [i, d.source_frames?.[i] ?? i, i / d.fps, v == null ? '—' : v.toFixed(4)]) };
    }
    const colors = cache.left.frames.map(i => {
        const l = cache.left.speeds[i] > Math.max((cache.left.stats.median || 0) * .35, 1e-4);
        const r = !single && cache.right.speeds[i] > Math.max((cache.right.stats.median || 0) * .35, 1e-4);
        return l && r ? '#c78fa7' : l ? '#d39a7b' : r ? '#9ab9df' : '#6b625d';
    });
    const stops = []; let start = 0;
    for (let i = 1; i <= colors.length; i++) if (i === colors.length || colors[i] !== colors[start]) {
        stops.push(`${colors[start]} ${100 * start / colors.length}% ${100 * i / colors.length}%`); start = i;
    }
    $('timeline-track').style.background = `linear-gradient(90deg, ${stops.join(',')})`;
}

// 完整路径只用线，减少拖动时 hover 抢事件；当前点保留 marker 便于点选。
function traces(arm) {
    const a = ARMS[arm], c = cache[arm];
    const hovertemplate = `frame %{customdata[0]} · source %{customdata[1]}<br>t=%{customdata[2]:.3f} s<br>x=%{x:.4f} m · y=%{y:.4f} m · z=%{z:.4f} m<br>v=%{customdata[3]} m/s<extra>${a.name}</extra>`;
    return [
        { type: 'scatter3d', mode: 'lines', hoverinfo: 'skip', showlegend: false, x: c.x, y: c.y, z: c.z, name: `${a.name}完整`, opacity: .3, line: { color: a.color, width: 4 } },
        { type: 'scatter3d', mode: 'lines', hovertemplate, showlegend: false, x: c.x.slice(0, 1), y: c.y.slice(0, 1), z: c.z.slice(0, 1), customdata: c.custom.slice(0, 1), name: `${a.name}已播放`, line: { color: a.color, width: 7 } },
        { type: 'scatter3d', mode: 'markers', hovertemplate, showlegend: false, x: [c.x[0]], y: [c.y[0]], z: [c.z[0]], customdata: [c.custom[0]], name: `${a.name}当前`, marker: { color: a.light, size: 8, line: { color: '#fff', width: 1 } } },
    ];
}

// 鼠标操作只更新了 WebGL 相机时，将事件快照同步给下一次 restyle 使用的布局。
function rememberCamera(event) {
    const camera = event['scene.camera'];
    if (camera && $('plot').layout?.scene) $('plot').layout.scene.camera = structuredClone(camera);
}

async function setCamera(camera) {
    const plot = $('plot');
    if (!plot?.layout?.scene) return;
    plot.layout.scene.camera = structuredClone(camera);
    await Plotly.relayout(plot, { 'scene.camera': camera });
}

async function applyCameraPreset(name) {
    if (!ready || !d) return;
    const camera = name === 'home' ? (homeCamera || trajectoryInitialCamera(d, bounds)) : presetCamera(name, d, bounds || sceneBounds(d));
    homeCamera = homeCamera || trajectoryInitialCamera(d, bounds || sceneBounds(d));
    await setCamera(camera);
}

async function setDragMode(mode) {
    dragMode = mode === 'orbit' ? 'orbit' : 'turntable';
    for (const button of document.querySelectorAll('[data-dragmode]')) button.classList.toggle('active', button.dataset.dragmode === dragMode);
    if ($('plot')?.layout?.scene) await Plotly.relayout('plot', { 'scene.dragmode': dragMode });
}

// 数据加载时初始化，重载只绑定一份相机和点选监听器。
async function draw() {
    const plot = $('plot');
    bounds = bounds || sceneBounds(d);
    homeCamera = trajectoryInitialCamera(d, bounds);
    const camera = homeCamera;
    plot.removeAllListeners?.('plotly_click');
    plot.removeAllListeners?.('plotly_doubleclick');
    plot.removeListener?.('plotly_relayouting', rememberCamera);
    plot.removeListener?.('plotly_relayout', rememberCamera);
    await Plotly.react(plot, [...Object.keys(ARMS).flatMap(traces), ...axisTraces(d)], {
        uirevision: `ee-trajectory-${generation}`, paper_bgcolor: '#fffaf5', font: { color: '#262421' },
        margin: { l: 0, r: 0, t: 24, b: 0 }, hovermode: 'closest',
        scene: {
            aspectmode: 'data', dragmode: dragMode, camera,
            ...axisLayout(bounds),
        },
    }, PLOT_CONFIG);
    plot.on('plotly_click', clicked);
    plot.on('plotly_doubleclick', () => { if (homeCamera) setCamera(homeCamera); });
    // 拖动过程中也同步，播放与旋转同时发生时不会使用上一次松手的视角。
    plot.on('plotly_relayouting', rememberCamera);
    plot.on('plotly_relayout', rememberCamera);
    for (const button of document.querySelectorAll('[data-dragmode]')) button.classList.toggle('active', button.dataset.dragmode === dragMode);
    for (const arm of Object.keys(ARMS)) {
        const a = ARMS[arm], c = cache[arm], chart = $(`speed-chart-${arm}`);
        const series = [
            { x: c.frames, y: c.speeds, customdata: c.custom, mode: 'lines', name: '全部', line: { color: '#cfc4bb', width: 1.2 } },
            { x: [0], y: [null], customdata: [c.custom[0]], mode: 'lines', name: '已播放', line: { color: a.color, width: 2 } },
        ];
        for (const [key, label, dash] of [['median', '中位数', 'dash'], ['mean', '平均数', 'dot']]) if (c.stats[key] !== null) {
            series.push({ x: [0, Math.max(1, d.frames - 1)], y: [c.stats[key], c.stats[key]], mode: 'lines', name: label, line: { color: a.light, width: 1.4, dash }, hovertemplate: `${label}（非零）%{y:.4f} m/s<extra></extra>` });
        }
        chart.removeAllListeners?.('plotly_click');
        await Plotly.react(chart, series, {
            margin: { l: 38, r: 8, t: 35, b: 20 }, autosize: true, paper_bgcolor: '#fffaf5', plot_bgcolor: '#fffaf5',
            font: { color: '#62584f', size: 9 }, title: { text: `${a.name}速度`, font: { size: 11 }, x: .02 },
            legend: { orientation: 'h', x: 0, y: 1.12, font: { size: 9 } },
            xaxis: { range: [0, Math.max(1, d.frames - 1)], gridcolor: '#eadfd5' }, yaxis: { title: { text: 'm/s' }, gridcolor: '#eadfd5' }, uirevision: `${generation}-${arm}`,
        }, { responsive: true, displaylogo: false });
        chart.on('plotly_click', clicked);
    }
    await applyArmView();
}

// 点选只接受真正带有采样帧号的轨迹点。
function clicked(event) {
    if (rotating) return;
    const frame = event.points?.[0]?.customdata?.[0];
    if (Number.isInteger(frame)) seek(frame);
}

// 同一帧不重复渲染；绘图积压时仅保留最新目标帧。
function render(frame) {
    if (!ready || !Number.isInteger(frame) || frame === lastFrame) return;
    pendingFrame = frame;
    if (rendering || rotating) return;
    rendering = true;
    schedule(async () => {
        if (!ready || rotating || pendingFrame === null) return;
        const f = pendingFrame; pendingFrame = null;
        // 只更新轨迹数据，保留用户最新相机，不写回异步绘图前的旧视角。
        const update = { x: [], y: [], z: [], customdata: [] }, indices = [], speeds = [];
        for (const arm of Object.keys(ARMS)) {
            const c = cache[arm], a = ARMS[arm];
            for (const axis of ['x', 'y', 'z']) update[axis].push(c[axis].slice(0, f + 1), [c[axis][f]]);
            update.customdata.push(c.custom.slice(0, f + 1), [c.custom[f]]); indices.push(a.base + 1, a.base + 2);
            speeds.push(Plotly.restyle(`speed-chart-${arm}`, { x: [c.frames.slice(0, f + 1)], y: [c.speeds.slice(0, f + 1)], customdata: [c.custom.slice(0, f + 1)] }, [1]));
            for (const axis of ['x', 'y', 'z']) $(`${arm}-${axis}`).textContent = c[axis][f].toFixed(4);
            $(`${arm}-v`).textContent = c.speeds[f] == null ? '—' : c.speeds[f].toFixed(4);
        }
        await Promise.all([Plotly.restyle('plot', update, indices), ...speeds]);
        lastFrame = f; scrub.value = f;
        $('frame').textContent = d.source_frames ? `输出帧 ${f}/${d.frames - 1} · 原始帧 ${d.source_frames[f]}` : `frame ${f}/${d.frames - 1}`;
        $('time').textContent = `${(f / d.fps).toFixed(3)} s`;
    }).catch(() => {}).finally(() => { rendering = false; if (ready && !rotating && pendingFrame !== null) render(pendingFrame); });
}

// 仅在真正拖动时冻结 restyle；单击选点仍即时更新。
{
    const plot = $('plot');
    let pointerId = null, originX = 0, originY = 0;
    plot.addEventListener('pointerdown', e => {
        if (e.button !== 0 && e.button !== 2) return;
        pointerId = e.pointerId; originX = e.clientX; originY = e.clientY; rotating = false;
    }, { capture: true });
    plot.addEventListener('pointermove', e => {
        if (pointerId !== e.pointerId) return;
        if (Math.hypot(e.clientX - originX, e.clientY - originY) > 3) rotating = true;
    }, { capture: true });
    for (const name of ['pointerup', 'pointercancel', 'blur']) window.addEventListener(name, () => {
        pointerId = null;
        const was = rotating;
        rotating = false;
        if (was && ready && pendingFrame !== null) render(pendingFrame);
    });
}

// 坐标轴和相机保持原样，仅切换图层可见性。
async function applyArmView() {
    for (const [arm, a] of Object.entries(ARMS)) await Plotly.restyle('plot', { visible: !d.single_arm || arm !== 'right' ? (armView === 'both' || armView === arm) : false }, [a.base, a.base + 1, a.base + 2]);
}
function setArmView(mode) {
    if (ready) { armView = mode; schedule(applyArmView).catch(() => {}); }
}
function setRate(rate) {
    if (!ready) return;
    video.playbackRate = rate;
    for (const el of secondaryVideos) el.playbackRate = rate;
}

// 按视频帧区间取整；微小容差抵消 MP4 时间戳舍入。
function currentFrame(time = video.currentTime) { return Math.max(0, Math.min(d.frames - 1, Math.floor(time * d.fps + 1e-4))); }
function seek(frame) {
    if (!ready) return;
    const time = (Math.max(0, Math.min(d.frames - 1, frame)) + .001) / d.fps;
    video.currentTime = time;
    syncSecondaryVideos(time);
}
function stopClock() {
    if (clock === null) return;
    video.cancelVideoFrameCallback ? video.cancelVideoFrameCallback(clock) : cancelAnimationFrame(clock);
    clock = null;
}

// 优先用实际呈现帧驱动轨迹，旧浏览器回退到动画回调。
function startClock() {
    stopClock(); const id = generation;
    const tick = (_now, metadata) => {
        clock = null;
        if (!ready || id !== generation) return;
        if (!video.seeking) {
            const time = metadata?.mediaTime ?? video.currentTime;
            syncSecondaryVideos(time);
            render(currentFrame(time));
        }
        if (!video.paused && !video.ended) next();
    };
    const next = () => { clock = video.requestVideoFrameCallback ? video.requestVideoFrameCallback(tick) : requestAnimationFrame(tick); };
    if (ready && !video.paused) next();
}

// 两个分隔条共用拖动逻辑，保留原来的横向/纵向布局调整。
function resizer(id, parent, axis, initial, min, max, update) {
    const handle = $(id); let ratio = initial, pointer = null, origin = 0, start = initial;
    const set = value => { ratio = Math.max(min, Math.min(max, value)); update(ratio); handle.setAttribute('aria-valuenow', Math.round(ratio * 100)); };
    handle.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        pointer = e.pointerId; origin = axis === 'x' ? e.clientX : e.clientY; start = ratio;
        handle.setPointerCapture(pointer); e.preventDefault();
    });
    handle.addEventListener('pointermove', e => {
        if (pointer === e.pointerId) set(start + ((axis === 'x' ? e.clientX : e.clientY) - origin) / Math.max(1, axis === 'x' ? parent.clientWidth : parent.clientHeight));
    });
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) handle.addEventListener(name, () => { pointer = null; });
    handle.addEventListener('dblclick', () => set(initial));
    handle.addEventListener('keydown', e => {
        const minus = axis === 'x' ? 'ArrowLeft' : 'ArrowUp', plus = axis === 'x' ? 'ArrowRight' : 'ArrowDown';
        if ([minus, plus, 'Home'].includes(e.key)) { e.preventDefault(); set(e.key === 'Home' ? initial : ratio + (e.key === plus ? .05 : -.05)); }
    });
}


enable(false);
    video.addEventListener('play', () => { playSecondaryVideos(); startClock(); });
    for (const name of ['pause', 'ended']) video.addEventListener(name, () => {
        pauseSecondaryVideos();
        stopClock();
        if (ready && !video.seeking) { syncSecondaryVideos(); render(currentFrame()); }
    });
    video.addEventListener('seeked', () => {
        if (!ready) return;
        syncSecondaryVideos();
        render(currentFrame());
        startClock();
    });
    video.addEventListener('timeupdate', () => {
        if (!ready || video.seeking) return;
        if (video.paused || !video.requestVideoFrameCallback) {
            syncSecondaryVideos();
            render(currentFrame());
        }
    });
    video.addEventListener('error', () => { if (ready) { enable(false); video.pause(); pauseSecondaryVideos(); stopClock(); message('视频播放失败，请重新加载 episode', true); } });
    video.addEventListener('ratechange', () => {
        if (!ready) return;
        $('rateSelect').value = String(video.playbackRate);
        for (const el of secondaryVideos) el.playbackRate = video.playbackRate;
    });
    scrub.addEventListener('input', () => seek(Number(scrub.value)));
    document.addEventListener('keydown', async e => {
        if (document.querySelector('dialog[open]') || !ready || e.repeat || e.target.closest('input, select, textarea, button, [contenteditable="true"], [role="separator"]')) return;
        if (e.code === 'Space') {
            e.preventDefault();
            try { video.paused ? await video.play() : video.pause(); } catch { message('无法播放视频，请重试', true); }
            return;
        }
        if (e.key === 'r' || e.key === 'R') { e.preventDefault(); schedule(() => applyCameraPreset('home')).catch(() => {}); }
        if (e.key === '1') { e.preventDefault(); schedule(() => applyCameraPreset('home')).catch(() => {}); }
        if (e.key === '2') { e.preventDefault(); schedule(() => applyCameraPreset('top')).catch(() => {}); }
        if (e.key === '3') { e.preventDefault(); schedule(() => applyCameraPreset('front')).catch(() => {}); }
        if (e.key === '4') { e.preventDefault(); schedule(() => applyCameraPreset('side')).catch(() => {}); }
    });
    const layout = document.querySelector('.layout'), panel = document.querySelector('.video-panel');
    resizer('column-resizer', layout, 'x', .62, .3, .7, r => layout.style.gridTemplateColumns = `minmax(0, ${r}fr) 8px minmax(0, ${1-r}fr)`);
    resizer('row-resizer', panel, 'y', .5, .2, .8, r => { panel.style.setProperty('--video-share', `${r}fr`); panel.style.setProperty('--charts-share', `${1-r}fr`); });
    let timer;
    const observer = new ResizeObserver(() => {
        clearTimeout(timer); timer = setTimeout(() => { if (ready) schedule(() => Promise.all(['plot', 'speed-chart-left', 'speed-chart-right'].map(id => Plotly.Plots.resize(id)))).catch(() => {}); }, 100);
    });
    for (const id of ['plot', 'speed-chart-left', 'speed-chart-right']) observer.observe($(id));
    window.addEventListener('pagehide', () => { if (mediaRelease) mediaRelease(); controller?.abort(); stopClock(); observer.disconnect(); clearTimeout(timer); });

for (const button of document.querySelectorAll('[data-arm]')) button.addEventListener('click', () => setArmView(button.dataset.arm));
for (const button of document.querySelectorAll('[data-camera]')) button.addEventListener('click', () => schedule(() => applyCameraPreset(button.dataset.camera)).catch(() => {}));
for (const button of document.querySelectorAll('[data-dragmode]')) button.addEventListener('click', () => schedule(() => setDragMode(button.dataset.dragmode)).catch(() => {}));
$('rateSelect').addEventListener('change', () => setRate(Number($('rateSelect').value)));
return { load, message };
};
