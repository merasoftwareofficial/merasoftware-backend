const staged = require('../../helpers/stagedUploads');
const upload = require('../../middleware/uploadFiles');
const wrap = handler => async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try { return await handler(req, res); }
  catch (error) {
    console.error('[upload-receipt]', error.status || error.code || 'unavailable');
    return res.status(error.status || 503).json({ success: false, error: true, message: error.status ? error.message : 'Upload could not be confirmed. Check its status before retrying.' });
  }
};
module.exports = {
  retryDelivery: wrap(async (req, res) => {
    if (req.userRole !== 'admin') return res.status(403).json({ success: false, message: 'Forbidden' });
    staged.configuration();
    const record = await require('../../models/uploadSubmissionModel').findOneAndUpdate({
      _id: req.params.submissionId, mode: 'staged', delivery: 'needs_review',
    }, { $set: { delivery: 'queued', attempts: 0, nextAttemptAt: new Date(), deliveryFailure: '' } }, { new: true });
    if (!record) return res.status(404).json({ success: false, message: 'Upload does not require a retry' });
    await require('../../models/updateRequestModel').updateOne({ _id: record.requestId }, { $set: { deliveryStatus: 'queued' } });
    return res.json({ success: true });
  }),
  begin: wrap(async (req, res) => {
    try { const record = await staged.begin(req); return res.json({ success: true, data: staged.publicStatus(record) }); }
    catch (error) {
      // Release only a reservation acquired by this request if no session owns it.
      if (req.externalUpload?.reservationId) {
        const existing = await require('../../helpers/uploadSubmission').findSubmission(req);
        if (!existing) await require('./externalUploadController').releaseReservation(req);
      }
      throw error;
    }
  }),
  authorizeFile: async (req, res, next) => {
    try { const record = await staged.load(req); if (!record.manifest.some(f => f.id === req.params.fileId)) return res.status(404).json({ success: false, message: 'File not found' }); next(); }
    catch (error) { res.status(error.status || 503).json({ success: false, message: 'Upload session unavailable' }); }
  },
  parseFile: (req, res, next) => upload.single('file')(req, res, error => error ? res.status(400).json({ success: false, message: error.message }) : next()),
  receive: wrap(async (req, res) => res.json({ success: true, data: staged.publicStatus(await staged.receive(req)) })),
  status: wrap(async (req, res) => res.json({ success: true, data: staged.publicStatus(await staged.load(req)) })),
  complete: wrap(async (req, res) => {
    const accepted = await staged.accept(req);
    if (!accepted.replay) await require('../../helpers/uploadNotifications').notifyUpload(accepted.requestId, req.uploadTiming).catch(() => console.warn('[upload] Notification preparation failed'));
    return res.json(accepted.response);
  }),
};
