// Retired: order email alerts are now sent by /api/order on the server, so this public endpoint is switched off.
// You can delete this file from GitHub.
module.exports = (req, res) => res.status(410).json({ error: 'Moved to /api/order' });
