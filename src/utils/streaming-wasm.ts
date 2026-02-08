export async function loadStreamingWasm(url: string, imports: WebAssembly.Imports = {}) {
  const response = await fetch(url);
  if ('instantiateStreaming' in WebAssembly) {
    // @ts-expect-error: TS' WebAssembly typings may lag browser support.
    const result = await WebAssembly.instantiateStreaming(response, imports);
    return result.instance;
  }
  const bytes = await response.arrayBuffer();
  const result = await WebAssembly.instantiate(bytes, imports);
  return result.instance;
}

