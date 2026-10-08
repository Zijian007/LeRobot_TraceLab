# LeRobot TraceLab（fork）

Fork of [Peaceful-World-X/LeRobot_TraceLab](https://github.com/Peaceful-World-X/LeRobot_TraceLab)（H01 轨迹工作台 / 洗碗任务抽帧）。

**G2 / Wholebody 数采请用仓内服务，不要再跑本目录的 `ee_video_viewer.py`：**

```bash
cd /home/agi/wholebody
bash launcher/real/start_tracelab.sh
```

说明：[wholebody/docs/guides/visualize-with-tracelab.md](../wholebody/docs/guides/visualize-with-tracelab.md) · 代码：[wholebody/external_services/tracelab](../wholebody/external_services/tracelab)。

本仓库保留：

- 通用 LeRobot v2.1 查看器（H01 / RoboDojo / EBench 等字段映射）
- H01 洗碗任务 `tools/reconstruct_dataset.py` 抽帧
- GitHub Pages 公开演示页

本 fork 远程：https://github.com/Zijian007/LeRobot_TraceLab

---

## 通用查看器（H01 等）

```bash
pip install fastapi 'pydantic>=2' uvicorn pyarrow numpy scipy plotly pyyaml
python ee_video_viewer.py
```

打开 http://localhost:9090，选类别，填数据集总目录和 episode。字段映射在 `ee_video_viewer.yaml`。

## H01 数据集重构

```bash
python tools/reconstruct_dataset.py \
    --source-root /path/to/H01_dataset \
    --all-episodes \
    --target-duration 24 \
    --workers 16
```

规则针对 H01 洗碗五阶段（右—左—右—左—右），与 G2 Wholebody 采数无关。
