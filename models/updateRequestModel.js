const mongoose = require('mongoose');

const updateRequestSchema = new mongoose.Schema({
  deliveryStatus: { type: String, enum: ['queued', 'ready', 'needs_review'], default: 'ready' },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'user',
    required: true
  },
  updatePlanId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'order',
    required: true
  },
  instructions: [{
    text: String,
    timestamp: {
      type: Date,
      default: Date.now
    }
  }],
  files: [{
    filename: {
      type: String,
      required: true
    },
    originalName: {
      type: String
    },
    type: {
      type: String
    },
    size: {
      type: Number
    },
    driveFileId: {
      type: String
    },
    driveLink: {
      type: String
    },
    // submitUpdateRequest.js has always built and passed a downloadLink, but the field
    // was missing here, so Mongoose silently dropped it on every save — zero of the 45
    // stored files carry one. Declared now to match clientDocumentSchema (userModel),
    // where the same field has always worked. Existing records stay readable: the link
    // is derivable from driveFileId, so nothing depends on this being backfilled.
    downloadLink: {
      type: String
    },
    embedLink: {
      type: String
    },
    expirationDate: {
      type: Date
    }
  }],
  status: {
    type: String,
    enum: ['pending', 'in_progress', 'completed', 'rejected'],
    default: 'pending'
  },
  assignedDeveloper: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Developer',
    default: null
  },
  developerNotes: [{
    text: String,
    timestamp: {
      type: Date,
      default: Date.now
    }
  }],
  developerMessages: [{
    message: String,
    timestamp: {
      type: Date,
      default: Date.now
    }
  }],
  completedAt: Date,
}, {
  timestamps: true
});



// Virtual field to get the completed status
updateRequestSchema.virtual('isCompleted').get(function() {
  return this.status === 'completed';
});

// Middleware to auto-update timestamps
updateRequestSchema.pre('save', function(next) {
  if (this.isModified('status') && this.status === 'completed' && !this.completedAt) {
    this.completedAt = new Date();
  }
  next();
});

// Create indexes for better query performance
updateRequestSchema.index({ userId: 1, createdAt: -1 });
updateRequestSchema.index({ updatePlanId: 1 });
updateRequestSchema.index({ status: 1 });
updateRequestSchema.index({ assignedDeveloper: 1, status: 1 });


const updateRequestModel = mongoose.model('UpdateRequest', updateRequestSchema);

module.exports = updateRequestModel;
