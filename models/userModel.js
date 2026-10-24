const mongoose = require("mongoose")

const referralSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'user',
        required: true
    },
    role: {
        type: String,
        required: true
    },
    referredDate: {
        type: Date,
        default: Date.now
    }
}, { _id: false })

// Admin-sent document attached to a client (agreement, signed doc, etc.).
// Reuses the exact same Google Drive shape as leadModel.proposals[] /
// leadModel.followUpAttachment, so file handling stays a single pattern across
// the codebase. Lives on the client (userModel), not on an order/node, so a
// client with no running project (e.g. a demo client) still has one place an
// agreement can be sent to. nodeId/orderId are optional back-links, set only
// when the document was uploaded during a project node update, so the customer
// Documents timeline can show which node update it arrived with.
const clientDocumentSchema = new mongoose.Schema({
    name: {
        type: String,
        default: ""
    },
    driveFileId: {
        type: String,
        default: ""
    },
    downloadLink: {
        type: String,
        default: ""
    },
    type: {
        type: String,
        default: ""
    },
    size: {
        type: Number,
        default: 0
    },
    // Classifies the document for the customer-facing label. Extendable later.
    source: {
        type: String,
        enum: ['agreement', 'general'],
        default: 'general'
    },
    // Optional project-node back-links (empty for client-level uploads).
    orderId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'order',
        default: null
    },
    nodeId: {
        type: String,
        default: null
    },
    uploadedAt: {
        type: Date,
        default: Date.now
    },
    uploadedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'user'
    }
}, { _id: true });

const userSchema = new mongoose.Schema({
    name: String,
    email: {
        type: String,
        required : true,
        unique: true,
    },
    password: String,
    profilePic : String,
    phone: String,     // Added phone field
    // WhatsApp OTP provision (helpers/phoneNumber.js). Nothing verifies numbers yet.
    phoneVerified: { type: Boolean, default: false },
    phoneVerifiedAt: { type: Date, default: null },
    dob: {                    // New field: Date of Birth
      type: Date
    },
    age: Number,      // Added age field
    roles: {
        type: [String],
        required: true,
        default: []
    },
    isOtpVerified: {
        type: Boolean,
        default: false
    },
    // Set true when a user is auto-created (e.g. lead convert) with a universal
    // password. Frontend uses it to prompt a first-login password reset.
    mustResetPassword: {
        type: Boolean,
        default: false
    },
    // Plaintext copy of the password, stored only so an admin can view a user's
    // password from the client workspace. Written alongside the bcrypt hash at
    // signup / convert / reset, and backfilled on successful login for
    // pre-existing users. Gated by config/accessControlConfig.STORE_PLAIN_PASSWORD;
    // never used for authentication (login always compares the hash).
    plainPassword: {
        type: String,
        default: undefined
    },
    // Login gate. When false, an admin has disabled this account and login is
    // blocked in userSignIn. Default true so all existing users stay active.
    isActive: {
        type: Boolean,
        default: true
    },
    // Client-controlled consent for a generated link to skip credential verification.
    // This grants upload-only convenience, never portal access.
    allowLoginFreeUploadLinks: { type: Boolean, default: false },
    uploadLinkConsentHistory: {
        type: [{
            enabled: { type: Boolean, required: true },
            changedAt: { type: Date, default: Date.now }
        }],
        default: []
    },
    // Soft-delete (Trash system). deletedAt null = active/visible everywhere as
    // before; a date = the record is in Trash (hidden from all admin lists/search)
    // and is permanently purged 30 days later. Restoring clears it back to null.
    // Additive + default null, so every pre-existing user stays active.
    deletedAt: {
        type: Date,
        default: null
    },
    deletedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'user',
        default: null
    },
    // Guest login system. isGuest flags a temporary, fully-functional demo
    // account (same models as a real customer). guestLeadId links back to the
    // leadModel record created alongside it. lastActivityAt drives 24h-inactivity
    // expiry (refreshed on every authenticated request); a guest with no activity
    // for 24h and no live chess game is cascade-deleted, but its lead is kept.
    isGuest: {
        type: Boolean,
        default: false
    },
    guestLeadId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'lead',
        default: null
    },
    lastActivityAt: {
        type: Date,
        default: null
    },
    walletBalance: {
        type: Number,
        default: 0    
    },
    referredBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'user'
    },
    referrals: [referralSchema],
    // Admin-sent documents (agreements etc.) for this client. Additive + default
    // [], so every pre-existing user stays unaffected. See clientDocumentSchema.
    documents: {
        type: [clientDocumentSchema],
        default: []
    },
     bankAccounts: [
    {
      bankName: String,
      bankAccountNumber: String,
      bankIFSCCode: String,
      accountHolderName: String,
      upiId: String,
      qrCode: String, // URL to uploaded QR code image
      isPrimary: {
        type: Boolean,
        default: false
      }
    }
  ],
  userDetails: {
  address: {
    streetAddress: String,
    city: String,
    state: String,
    pinCode: String,
    landmark: String
  },
  kycDocuments: {
    documentType: String, // e.g., 'aadhar', 'driving_license'
    documentFrontPhoto: String, // URL or base64
    documentBackPhoto: String, // URL or base64 (optional for DL)
    selfiePhoto: String
  },
  isDetailsCompleted: {
    type: Boolean,
    default: false
  },
  // --- NEW KYC FIELDS START ---
    kycStatus: {
      type: String,
      enum: ['pending', 'approved', 'rejected'], // Define allowed statuses
      default: 'pending' // Default status when details are completed
    },
    kycRejectionReasons: {
      type: [String], // Array to store multiple rejection reasons
      default: []
    },
    kycApprovedAt: {
      type: Date // Timestamp when KYC was approved
    },
    kycRejectedAt: {
      type: Date // Timestamp when KYC was rejected
    },
    kycAdminNotes: {
      type: String 
    }
    // --- NEW KYC FIELDS END ---
}
},{
    timestamps: true
})

const userModel = mongoose.model("user",userSchema)

module.exports = userModel
