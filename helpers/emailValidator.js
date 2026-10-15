const dns = require('dns').promises;

/**
 * List of common disposable/temporary email domains
 */
const DISPOSABLE_EMAIL_DOMAINS = [
  '10minutemail.com',
  'tempmail.com',
  'guerrillamail.com',
  'mailinator.com',
  'throwaway.email',
  'temp-mail.org',
  'getnada.com',
  'fakeinbox.com',
  'maildrop.cc',
  'trashmail.com',
  'yopmail.com',
  'sharklasers.com',
  'guerrillamail.info',
  'grr.la',
  'guerrillamail.biz',
  'guerrillamail.de',
  'spam4.me',
  'tmails.net',
  'emailondeck.com',
  'temp-mail.io'
];

/**
 * List of common fake/test email addresses
 */
const FAKE_EMAIL_ADDRESSES = [
  'test@gmail.com',
  'test@test.com',
  'example@gmail.com',
  'example@example.com',
  'test@yahoo.com',
  'test@outlook.com',
  'fake@gmail.com',
  'fake@fake.com',
  'demo@gmail.com',
  'demo@demo.com',
  'sample@gmail.com',
  'admin@test.com'
];

/**
 * Validate email format using regex
 * @param {string} email - Email address to validate
 * @returns {boolean} - True if format is valid
 */
const validateEmailFormat = (email) => {
  if (!email || typeof email !== 'string') {
    return false;
  }

  // Comprehensive email regex pattern
  const emailRegex = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

  // Basic format check
  if (!emailRegex.test(email)) {
    return false;
  }

  // Additional checks
  const parts = email.split('@');
  if (parts.length !== 2) {
    return false;
  }

  const [localPart, domain] = parts;

  // Local part shouldn't be empty or too long
  if (!localPart || localPart.length > 64) {
    return false;
  }

  // Domain shouldn't be empty or too long
  if (!domain || domain.length > 255) {
    return false;
  }

  // Domain should have at least one dot
  if (!domain.includes('.')) {
    return false;
  }

  return true;
};

/**
 * Check if email domain has valid MX records
 * @param {string} email - Email address to validate
 * @returns {Promise<{isValid: boolean, message?: string}>}
 */
const validateEmailDomain = async (email) => {
  try {
    const domain = email.split('@')[1];

    if (!domain) {
      return {
        isValid: false,
        message: 'Invalid email format'
      };
    }

    // Perform MX record lookup
    try {
      const addresses = await dns.resolveMx(domain);

      if (addresses && addresses.length > 0) {
        return {
          isValid: true,
          message: 'Valid email domain'
        };
      } else {
        return {
          isValid: false,
          message: 'Your email is not valid. Please enter a valid and working email address.'
        };
      }
    } catch (dnsError) {
      // DNS lookup failed - domain doesn't exist or has no MX records
      if (dnsError.code === 'ENODATA' || dnsError.code === 'ENOTFOUND') {
        return {
          isValid: false,
          message: 'Your email is not valid. Please enter a valid and working email address.'
        };
      }

      // For other DNS errors, log but allow (to avoid false negatives)
      console.warn(`DNS lookup warning for ${domain}:`, dnsError.message);
      return {
        isValid: true,
        message: 'Email domain validation skipped due to DNS error'
      };
    }
  } catch (error) {
    console.error('Error validating email domain:', error);
    // On general error, allow the email (to avoid blocking valid emails)
    return {
      isValid: true,
      message: 'Email domain validation skipped'
    };
  }
};

/**
 * Check if email is from a disposable/temporary email service
 * @param {string} email - Email address to check
 * @returns {boolean} - True if disposable
 */
const isDisposableEmail = (email) => {
  if (!email || typeof email !== 'string') {
    return false;
  }

  const domain = email.split('@')[1]?.toLowerCase();

  if (!domain) {
    return false;
  }

  return DISPOSABLE_EMAIL_DOMAINS.includes(domain);
};

/**
 * Check if email is a common fake/test email
 * @param {string} email - Email address to check
 * @returns {boolean} - True if fake
 */
const isFakeEmail = (email) => {
  if (!email || typeof email !== 'string') {
    return false;
  }

  return FAKE_EMAIL_ADDRESSES.includes(email.toLowerCase());
};

/**
 * Complete email validation
 * Validates format, domain MX records, and checks for disposable/fake emails
 * @param {string} email - Email address to validate
 * @returns {Promise<{isValid: boolean, message: string}>}
 */
const validateEmail = async (email) => {
  try {
    // 1. Format validation
    if (!validateEmailFormat(email)) {
      return {
        isValid: false,
        message: 'Invalid email format. Please enter a valid email address.'
      };
    }

    // 2. Check for fake/test emails
    if (isFakeEmail(email)) {
      return {
        isValid: false,
        message: 'Please use a real email address, not a test email.'
      };
    }

    // 3. Check for disposable emails
    if (isDisposableEmail(email)) {
      return {
        isValid: false,
        message: 'Disposable email addresses are not allowed. Please use a permanent email.'
      };
    }

    // 4. Domain MX record validation
    const domainValidation = await validateEmailDomain(email);
    if (!domainValidation.isValid) {
      return {
        isValid: false,
        message: domainValidation.message || 'Email domain cannot receive emails.'
      };
    }

    // All validations passed
    return {
      isValid: true,
      message: 'Email is valid'
    };

  } catch (error) {
    console.error('Error in email validation:', error);
    // On error, return invalid to be safe
    return {
      isValid: false,
      message: 'Unable to validate email. Please try again.'
    };
  }
};

/**
 * Shape check for an account or lead email, the same rule sign-up applies
 * (controller/user/userSignUp.js). Deliberately looser than validateEmailFormat,
 * which rejects addresses sign-up accepts (e.g. name+tag@gmail.com).
 * @param {string} email - Email address, already trimmed and lowercased
 * @returns {boolean} - True if it looks like name@domain.tld
 */
const isAccountEmail = (email) => typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

module.exports = {
  isAccountEmail,
  validateEmailFormat,
  validateEmailDomain,
  isDisposableEmail,
  isFakeEmail,
  validateEmail
};
