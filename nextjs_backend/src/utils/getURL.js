function getURL() {
  let url = process.env.SITE_URL || 'http://localhost:3000/';

  if (!url.startsWith('http')) {
    url = `https://${url}`;
  }
  if (!url.endsWith('/')) {
    url = `${url}/`;
  }
  return url;
}

module.exports = { getURL };
