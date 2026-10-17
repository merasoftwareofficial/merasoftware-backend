// Limits apply to active HTTP requests, never detached/background work.
function createGate(limit) {
  let active = 0;
  const waiting = [];
  return async operation => {
    await new Promise(resolve => {
      const enter = () => { active++; resolve(); };
      if (active < limit) enter(); else waiting.push(enter);
    });
    try { return await operation(); }
    finally { active--; waiting.shift()?.(); }
  };
}

// Shared by every Drive upload in this Node process, including other clients.
const runDriveUpload = createGate(6);

async function uploadBatch(files, uploadOne, cleanup, progress = async () => {}) {
  const results = new Array(files.length);
  let cursor = 0;
  let failure;
  const workers = Array.from({ length: Math.min(3, files.length) }, async () => {
    while (!failure && cursor < files.length) {
      const index = cursor++;
      try {
        results[index] = await uploadOne(files[index], index, () => Boolean(failure));
        if (results[index]) await progress();
      } catch (error) { failure ||= error; }
    }
  });
  await Promise.all(workers); // Settle every in-flight operation before cleanup.
  if (failure) {
    const cleaned = await Promise.allSettled(results.filter(Boolean).map(cleanup));
    if (cleaned.some(result => result.status === 'rejected')) failure.uploadCleanupFailed = true;
    throw failure;
  }
  return results;
}

module.exports = { createGate, runDriveUpload, uploadBatch };
