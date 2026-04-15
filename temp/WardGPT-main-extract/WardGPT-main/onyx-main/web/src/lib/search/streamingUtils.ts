import { PacketType } from "@/app/app/services/lib";

export async function* handleSSEStream<T extends PacketType>(
  streamingResponse: Response,
  signal?: AbortSignal
): AsyncGenerator<T, void, unknown> {
  const reader = streamingResponse.body?.getReader();
  if (!reader) {
    throw new Error("No response stream available");
  }
  const decoder = new TextDecoder();
  let buffer = "";
  let emittedPacketCount = 0;
  if (signal) {
    signal.addEventListener("abort", () => {
      console.log("aborting");
      reader?.cancel();
    });
  }
  while (true) {
    let rawChunk: ReadableStreamReadResult<Uint8Array>;
    try {
      rawChunk = await reader.read();
    } catch (error) {
      if (signal?.aborted) {
        throw new Error("AbortError");
      }
      // Some proxy layers may terminate chunked streams without a clean EOF.
      // If we already received packets, degrade gracefully and let callers
      // finalize the stream instead of surfacing a hard error.
      if (emittedPacketCount > 0 || buffer.trim() !== "") {
        break;
      }
      throw new Error("Stream connection interrupted before completion");
    }
    const { done, value } = rawChunk;
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (line.trim() === "") continue;

      try {
        const data = JSON.parse(line) as T;
        emittedPacketCount += 1;
        yield data;
      } catch (error) {
        console.error("Error parsing SSE data:", error);

        // Detect JSON objects (ie. check if parseable json has been accumulated)
        const jsonObjects = line.match(/\{[^{}]*\}/g);
        if (jsonObjects) {
          for (const jsonObj of jsonObjects) {
            try {
              const data = JSON.parse(jsonObj) as T;
              emittedPacketCount += 1;
              yield data;
            } catch (innerError) {
              console.error("Error parsing extracted JSON:", innerError);
            }
          }
        }
      }
    }
  }

  // Process any remaining data in the buffer
  if (buffer.trim() !== "") {
    try {
      const data = JSON.parse(buffer) as T;
      emittedPacketCount += 1;
      yield data;
    } catch (error) {
      console.error("Error parsing remaining buffer:", error);
    }
  }
}
