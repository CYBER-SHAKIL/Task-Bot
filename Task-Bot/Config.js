require('dotenv').config();

module.exports = {
  BOT_TOKEN: process.env.BOT_TOKEN,
  FIREBASE_SERVICE_ACCOUNT: process.env.FIREBASE_SERVICE_ACCOUNT,
  ADMIN_IDS: (process.env.ADMIN_IDS || '8361587941')
    .split(',')
    .map((x) => Number(x.trim()))
    .filter(Boolean),
  // Mini App ei server theke-i serve hoy, tai alada hosting lagbe na
  WEBAPP_URL: process.env.WEBAPP_URL || process.env.RENDER_EXTERNAL_URL || '',
  WEBHOOK_URL: process.env.WEBHOOK_URL || process.env.RENDER_EXTERNAL_URL || '',
  PORT: process.env.PORT || 3000,

  // Force-join channels. Bot must be ADMIN in each channel to check membership.
  // Pore aro channel add korte ekta object add koro.
  CHANNELS: [
    { title: 'Our Channel', username: '@Shakil_X9X', url: 'https://t.me/Shakil_X9X' },
    // { title: 'Channel 2', username: '@your_second_channel', url: 'https://t.me/your_second_channel' },
  ],

  // Amounts in BDT (taka)
  REFERRAL_BONUS: 5,
  DAILY_BONUS: 1,
  MIN_WITHDRAW: 50,
};
  
