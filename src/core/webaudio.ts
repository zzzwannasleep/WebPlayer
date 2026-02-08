type BaseSampleFormat = 'u8' | 's16' | 's32' | 'f32';

function normalizeSampleFormat(format: AudioSampleFormat): {
  planar: boolean;
  base: BaseSampleFormat;
} {
  const f = String(format);
  const planar = f.endsWith('-planar');
  const base = (planar ? f.slice(0, -'-planar'.length) : f) as BaseSampleFormat;
  switch (base) {
    case 'u8':
    case 's16':
    case 's32':
    case 'f32':
      return { planar, base };
    default:
      throw new Error(`Unsupported AudioData format: ${f}`);
  }
}

function copyPlaneToFloat32(
  audioData: AudioData,
  planeIndex: number,
  base: BaseSampleFormat,
  out: Float32Array,
) {
  switch (base) {
    case 'f32': {
      audioData.copyTo(out, { planeIndex });
      return;
    }
    case 's16': {
      const tmp = new Int16Array(out.length);
      audioData.copyTo(tmp, { planeIndex });
      for (let i = 0; i < tmp.length; i++) out[i] = tmp[i] / 32768;
      return;
    }
    case 's32': {
      const tmp = new Int32Array(out.length);
      audioData.copyTo(tmp, { planeIndex });
      for (let i = 0; i < tmp.length; i++) out[i] = tmp[i] / 2147483648;
      return;
    }
    case 'u8': {
      const tmp = new Uint8Array(out.length);
      audioData.copyTo(tmp, { planeIndex });
      for (let i = 0; i < tmp.length; i++) out[i] = (tmp[i] - 128) / 128;
      return;
    }
  }
}

function createTypedArrayForInterleaved(base: BaseSampleFormat, length: number): ArrayBufferView {
  switch (base) {
    case 'f32':
      return new Float32Array(length);
    case 's16':
      return new Int16Array(length);
    case 's32':
      return new Int32Array(length);
    case 'u8':
      return new Uint8Array(length);
  }
}

function sampleToFloat32(base: BaseSampleFormat, value: number): number {
  switch (base) {
    case 'f32':
      return value;
    case 's16':
      return value / 32768;
    case 's32':
      return value / 2147483648;
    case 'u8':
      return (value - 128) / 128;
  }
}

export function audioDataToAudioBuffer(context: AudioContext, audioData: AudioData): AudioBuffer {
  const channels = Math.max(1, audioData.numberOfChannels);
  const frames = Math.max(0, audioData.numberOfFrames);
  const sampleRate = Number.isFinite(audioData.sampleRate) && audioData.sampleRate > 0
    ? audioData.sampleRate
    : context.sampleRate;

  const buffer = context.createBuffer(channels, frames, sampleRate);
  if (frames === 0) return buffer;

  const format = audioData.format ?? 'f32-planar';
  const { planar, base } = normalizeSampleFormat(format);

  if (planar) {
    for (let ch = 0; ch < channels; ch++) {
      const dst = buffer.getChannelData(ch);
      copyPlaneToFloat32(audioData, ch, base, dst);
    }
    return buffer;
  }

  const interleaved = createTypedArrayForInterleaved(base, frames * channels);
  audioData.copyTo(interleaved, { planeIndex: 0 });

  if (base === 'f32') {
    const src = interleaved as Float32Array;
    for (let ch = 0; ch < channels; ch++) {
      const dst = buffer.getChannelData(ch);
      for (let i = 0; i < frames; i++) dst[i] = src[i * channels + ch];
    }
    return buffer;
  }

  for (let ch = 0; ch < channels; ch++) {
    const dst = buffer.getChannelData(ch);
    for (let i = 0; i < frames; i++) {
      const idx = i * channels + ch;
      const v =
        interleaved instanceof Int16Array
          ? interleaved[idx]
          : interleaved instanceof Int32Array
            ? interleaved[idx]
            : (interleaved as Uint8Array)[idx];
      dst[i] = sampleToFloat32(base, v);
    }
  }

  return buffer;
}
