const lines = (...rows) => rows.join('\n');
const SIGN_OFF = ['Best regards,', 'Mera Software Team'];
module.exports = {
    subject: 'Project Update: {{project}} - Milestone Completed',
    text: lines(
      'Hello {{name}},', '',
      'We have an exciting update on your website project **{{project}}**!', '',
      '## Milestone Completed',
      '**{{milestone}}** is now complete!',
      '{{message}}', '',
      '**Project Progress:** {{progress}} complete', '',
      '{{developer}} is working diligently to move your project forward. If you have any questions or need clarification, please do not hesitate to reach out.', '',
      'You can log in to your account to view detailed updates and provide feedback.', '',
      'Thank you for your continued collaboration!', '',
      ...SIGN_OFF,
    ),
};
