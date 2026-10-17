const { findSubmission } = require('../../helpers/uploadSubmission');

module.exports = async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const record = await findSubmission(req);
    if (!record) return res.status(404).json({ success: false, code: 'UPLOAD_NOT_RECEIVED' });
    const stalled = record.status === 'processing' && Date.now() - new Date(record.updatedAt).getTime() > 5 * 60 * 1000;
    return res.json({ success: true, data: {
      status: stalled ? 'needs_review' : record.status, phase: record.phase,
      completedFiles: record.completedFiles, totalFiles: record.totalFiles,
      result: record.status === 'succeeded' ? record.result : undefined,
    } });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: 'Upload status is unavailable' });
  }
};
