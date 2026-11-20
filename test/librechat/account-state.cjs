// Only for a disposable QA database. Never use against an owner's database.
const fs = require('node:fs');
require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');
(async () => {
  const { email, fenced } = JSON.parse(fs.readFileSync(0, 'utf8'));
  await mongoose.connect(process.env.MONGO_URI);
  if (mongoose.connection.name !== 'gateway_qa') throw new Error('Not a gateway QA database');
  const update = fenced
    ? { $set: { agentTriggerDeletionStartedAt: new Date(), updatedAt: new Date() } }
    : { $unset: { agentTriggerDeletionStartedAt: '' }, $set: { updatedAt: new Date() } };
  await mongoose.connection.db.collection('users').updateOne({ email }, update);
  process.exit(0);
})().catch(() => process.exit(1));
