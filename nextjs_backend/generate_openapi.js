const fs = require('fs');
const path = require('path');
const swaggerSpec = require('./swagger');

const outputDir = path.join(__dirname, 'interfaces');
const outputPath = path.join(outputDir, 'openapi.json');

if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

fs.writeFileSync(
  outputPath,
  JSON.stringify(swaggerSpec, null, 2)
);
