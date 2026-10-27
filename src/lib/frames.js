/**
 * 前端媒体处理：抽帧、分镜联系表拼图。
 * 全部走 <video> + Canvas，不依赖 ffmpeg。
 */

export function formatTime(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function waitForSeek(video, time) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      video.removeEventListener("seeked", finish);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, 1200);
    video.addEventListener("seeked", finish, { once: true });
    video.currentTime = Math.max(0, Math.min(time, Math.max(0, (video.duration || 0) - 0.05)));
  });
}

/**
 * 等分区间抽帧，取样点放在区间起点后 0.45s，避开转场黑帧。
 */
export async function extractFrames(video, count = 9, { width = 540, quality = 0.84, phased = true } = {}) {
  if (!video || !Number.isFinite(video.duration) || !video.duration) return [];
  const ratio = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 9 / 16;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = Math.round(width / ratio);
  const ctx = canvas.getContext("2d", { alpha: false });

  const duration = video.duration;
  const frames = [];

  const capture = async (time) => {
    await waitForSeek(video, time);
    ctx.fillStyle = "#111827";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", quality);
  };

  for (let index = 0; index < count; index += 1) {
    const start = (duration / count) * index;
    const end = (duration / count) * (index + 1);
    const span = Math.max(0.2, end - start);

    if (!phased) {
      const time = index === 0 ? Math.min(0.4, duration / 3) : Math.min(start + 0.45, duration - 0.1);
      frames.push({ index, time, start, end, image: await capture(time), phases: [] });
      continue;
    }

    // 同一分镜取前 / 中 / 后三个证据点，让模型看清一镜内的画面变化
    const points = [
      ["前", 0.1],
      ["中", 0.5],
      ["后", 0.9],
    ];
    const phases = [];
    for (const [label, ratio] of points) {
      const time = Math.min(start + span * ratio, Math.max(0, duration - 0.05));
      phases.push({ label, time, image: await capture(time) });
    }
    const mid = phases[1] || phases[0];
    frames.push({ index, start, end, time: mid.time, image: mid.image, phases });
  }
  return frames;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("分镜图片解码失败"));
    image.src = src;
  });
}

function drawFit(ctx, image, x, y, width, height) {
  ctx.fillStyle = "#111827";
  ctx.fillRect(x, y, width, height);
  const scale = Math.min(width / image.naturalWidth, height / image.naturalHeight);
  const w = image.naturalWidth * scale;
  const h = image.naturalHeight * scale;
  ctx.drawImage(image, x + (width - w) / 2, y + (height - h) / 2, w, h);
}

/**
 * 把分镜拼成联系表（默认 3 列 × 最多 9 格），每格标注 S1 / 时间区间。
 * 目的：把 N 张图压成 1~2 张，云端图片请求数降一个量级。
 */
export async function buildContactSheets(frames, { prefix = "S", maxPerSheet = 9 } = {}) {
  const usable = (frames || []).filter((f) => f?.image);
  if (!usable.length) return [];

  const sheets = [];
  let cursor = 0;

  while (cursor < usable.length) {
    // 每镜有 3 个证据点时，一张表最多放 3 镜（3×3=9 格）
    const chunk = [];
    let cells = 0;
    while (cursor < usable.length && cells < maxPerSheet) {
      const frame = usable[cursor];
      const itemCells = frame.phases?.length || 1;
      if (cells + itemCells > maxPerSheet && chunk.length) break;
      chunk.push(frame);
      cells += itemCells;
      cursor += 1;
    }

    const cellsList = [];
    for (const frame of chunk) {
      const phases = frame.phases?.length
        ? frame.phases
        : [{ label: "", time: frame.time, image: frame.image }];
      for (const phase of phases) {
        cellsList.push({
          image: phase.image,
          label: `${prefix}${Number(frame.index) + 1}${phase.label ? `-${phase.label}` : ""}`,
          range: `${formatTime(frame.start)}-${formatTime(frame.end)}`,
        });
      }
    }

    const columns = Math.min(3, cellsList.length);
    const rows = Math.ceil(cellsList.length / columns);
    const cellWidth = 300;
    const imageHeight = 500;
    const labelHeight = 44;

    const canvas = document.createElement("canvas");
    canvas.width = columns * cellWidth;
    canvas.height = rows * (imageHeight + labelHeight);
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.fillStyle = "#f3f6fa";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const images = await Promise.all(cellsList.map((cell) => loadImage(cell.image)));

    cellsList.forEach((cell, i) => {
      const x = (i % columns) * cellWidth;
      const y = Math.floor(i / columns) * (imageHeight + labelHeight);
      drawFit(ctx, images[i], x, y, cellWidth, imageHeight);

      ctx.fillStyle = "#ffffff";
      ctx.fillRect(x, y + imageHeight, cellWidth, labelHeight);
      ctx.strokeStyle = "#dbe5f2";
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 1, y + 1, cellWidth - 2, imageHeight + labelHeight - 2);

      ctx.fillStyle = "#172033";
      ctx.font = "700 16px Arial, sans-serif";
      ctx.fillText(`${cell.label}  ${cell.range}`, x + 12, y + imageHeight + 28);
    });

    sheets.push({
      image: canvas.toDataURL("image/jpeg", 0.78),
      frameIndexes: chunk.map((f) => Number(f.index)),
      layout: `${columns}x${rows}`,
      phases: chunk[0]?.phases?.map((p) => p.label) || [],
    });
  }
  return sheets;
}

/**
 * 左右配对联系表：左列对标 Bn，右列成品 Fn。用于终局对比。
 */
export async function buildPairedContactSheet(benchmarkFrames = [], finalFrames = []) {
  const pairCount = Math.max(benchmarkFrames.length, finalFrames.length);
  if (!pairCount) return [];

  const cellWidth = 340;
  const imageHeight = 430;
  const rowLabelHeight = 42;
  const headerHeight = 48;

  const canvas = document.createElement("canvas");
  canvas.width = cellWidth * 2;
  canvas.height = headerHeight + pairCount * (imageHeight + rowLabelHeight);
  const ctx = canvas.getContext("2d", { alpha: false });
  ctx.fillStyle = "#f3f6fa";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = "#172033";
  ctx.font = "700 18px Arial, sans-serif";
  ctx.fillText("BENCHMARK / 对标视频", 14, 31);
  ctx.fillText("FINAL / 成品视频", cellWidth + 14, 31);

  for (let index = 0; index < pairCount; index += 1) {
    const rowY = headerHeight + index * (imageHeight + rowLabelHeight);
    const b = benchmarkFrames[index];
    const f = finalFrames[index];
    const [bImg, fImg] = await Promise.all([
      b?.image ? loadImage(b.image).catch(() => null) : null,
      f?.image ? loadImage(f.image).catch(() => null) : null,
    ]);
    if (bImg) drawFit(ctx, bImg, 0, rowY, cellWidth, imageHeight);
    if (fImg) drawFit(ctx, fImg, cellWidth, rowY, cellWidth, imageHeight);

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, rowY + imageHeight, canvas.width, rowLabelHeight);
    ctx.strokeStyle = "#dbe5f2";
    ctx.strokeRect(0, rowY, cellWidth, imageHeight + rowLabelHeight);
    ctx.strokeRect(cellWidth, rowY, cellWidth, imageHeight + rowLabelHeight);

    ctx.fillStyle = "#172033";
    ctx.font = "700 15px Arial, sans-serif";
    ctx.fillText(`B${index + 1}  ${b ? formatTime(b.start) : "--"}`, 12, rowY + imageHeight + 27);
    ctx.fillText(`F${index + 1}  ${f ? formatTime(f.start) : "--"}`, cellWidth + 12, rowY + imageHeight + 27);
  }

  return [{ image: canvas.toDataURL("image/jpeg", 0.78), pairCount, layout: `2x${pairCount}` }];
}

/**
 * 把图片文件读成压缩后的 dataURL。
 * 千川后台截图通常是 1920×1080 的 PNG，直接 base64 会很大，这里统一压到 1400 宽。
 */
export function imageFileToDataUrl(file, { maxWidth = 1400, quality = 0.85 } = {}) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      try {
        const scale = Math.min(1, maxWidth / (image.naturalWidth || maxWidth));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round((image.naturalWidth || maxWidth) * scale));
        canvas.height = Math.max(1, Math.round((image.naturalHeight || maxWidth) * scale));
        const ctx = canvas.getContext("2d", { alpha: false });
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      } catch (error) {
        reject(error);
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("图片读取失败，请换一张 png/jpg"));
    };
    image.src = objectUrl;
  });
}

export function readVideoMeta(file) {  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    const url = URL.createObjectURL(file);
    video.preload = "metadata";
    video.muted = true;
    video.src = url;
    const timer = setTimeout(() => reject(new Error("视频元数据读取超时")), 15000);
    video.onloadedmetadata = () => {
      clearTimeout(timer);
      resolve({
        url,
        duration: video.duration,
        width: video.videoWidth,
        height: video.videoHeight,
        element: video,
      });
    };
    video.onerror = () => {
      clearTimeout(timer);
      reject(new Error("这个视频格式无法在预览器里解码，请换成 mp4/h264"));
    };
  });
}
