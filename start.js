/**
 * HiveLens — start.js
 * Binds the Express app to a port. Separated from server.js for test isolation.
 */

import 'dotenv/config';
import app from './src/server.js';

const PORT = parseInt(process.env.PORT || '3000', 10);

app.listen(PORT, () => {
  console.log(`[hivelens] listening on port ${PORT}`);
});
