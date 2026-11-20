// Disposable database only. Account JSON arrives on stdin and is never printed.
const fs = require('node:fs');
require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');
const { createModels, runAsSystem } = require('@librechat/data-schemas');
const { hashSecret } = require('@librechat/api');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const account = JSON.parse(fs.readFileSync(0, 'utf8'));
  const { User } = createModels(mongoose);
  const password = await hashSecret(account.password);
  await runAsSystem(() =>
    User.updateOne(
      { email: account.email },
      {
        $set: {
          ...account,
          password,
          role: 'ADMIN',
          provider: 'local',
          emailVerified: true,
        },
      },
      { upsert: true },
    ),
  );
  process.exit(0);
})().catch((error) => {
  console.error(error.name);
  process.exit(1);
});
