/**
 * 音轨提取：视频 → 16kHz 单声道 PCM → WAV 分片。
 *
 * 为什么必须在浏览器端做：
 * whisper.cpp 的 CLI 只靠 miniaudio 解码，支持 wav/mp3/flac/ogg，**不支持 mp4/mov**。
 * 而 Chromium 的 WebAudio 能直接解码视频容器里的 AAC 音轨，所以先在渲染进程解码，
 * 再以 30 秒 WAV 分片送给本地引擎，既绕过格式问题，也避免单片过长导致内存与超时。
 */

export const SAMPLE_RATE = 16000;
export const CHUNK_SECONDS = 30;

function resampleLinear(input, fromRate, toRate) {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const length = Math.floor(input.length / ratio);
  const output = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const position = i * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, input.length - 1);
    const weight = position - left;
    output[i] = input[left] * (1 - weight) + input[right] * weight;
  }
  return output;
}

/** 解码任意视频/音频文件的音轨，返回 16kHz 单声道 Float32Array。 */
export async function decodeAudioFromFile(file) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) throw new Error("当前环境不支持音频解码");

  const context = new AudioContextClass();
  try {
    const buffer = await file.arrayBuffer();
    const decoded = await context.decodeAudioData(buffer.slice(0));
    const mono = new Float32Array(decoded.length);
    for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
      const data = decoded.getChannelData(channel);
      for (let i = 0; i < data.length; i += 1) {
        mono[i] += data[i] / decoded.numberOfChannels;
      }
    }
    return {
      samples: resampleLinear(mono, decoded.sampleRate, SAMPLE_RATE),
      duration: decoded.duration,
    };
  } catch (error) {
    throw new Error(`音轨解码失败（视频可能没有音轨或编码不受支持）：${error.message || error}`);
  } finally {
    await context.close().catch(() => {});
  }
}

/** 16bit PCM 单声道 WAV 编码。 */
export function encodeWav(samples, sampleRate = SAMPLE_RATE) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeString = (offset, value) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

/** 按固定秒数切片，每片独立编码成 WAV Blob。 */
export function makeAudioChunks(samples, chunkSeconds = CHUNK_SECONDS, sampleRate = SAMPLE_RATE) {
  const chunkSize = Math.max(1, Math.floor(sampleRate * chunkSeconds));
  const chunks = [];
  for (let startSample = 0; startSample < samples.length; startSample += chunkSize) {
    const endSample = Math.min(samples.length, startSample + chunkSize);
    const slice = samples.slice(startSample, endSample);
    chunks.push({
      index: chunks.length,
      start: startSample / sampleRate,
      end: endSample / sampleRate,
      blob: encodeWav(slice, sampleRate),
    });
  }
  return chunks;
}

/** 把分片内的相对时间偏移回全局时间轴。 */
export function offsetSegments(segments, offset = 0) {
  return (segments || []).map((item) => ({
    ...item,
    start: Number(item.start || 0) + offset,
    end: Number(item.end || 0) + offset,
  }));
}
