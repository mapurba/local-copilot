// Dry-run: generate service runbook and extract shell script
// Usage: node scripts/dry_run_instantiate.js

const path = require('path');
const runbookModulePath = path.join(__dirname, '..', 'dist-electron', 'main', 'deployment', 'runbookGenerator.js');
let runbookGen;
try {
  runbookGen = require(runbookModulePath);
} catch (err) {
  console.error('Failed to require runbook generator. Did you run `npm run build` first?', err.message);
  process.exit(2);
}

const { generateServiceRunbook } = runbookGen;
if (!generateServiceRunbook) {
  console.error('generateServiceRunbook not found in compiled module.');
  process.exit(2);
}

// Sample design object
const design = {
  id: 'design-sample-1',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  documentId: 'doc-sample',
  intelligence: {
    products: [{ name: 'Example Product' }],
    deploymentModes: [{ name: 'distributed' }],
  },
  vms: [
    {
      id: 'vm-1',
      vmName: 'web-01',
      role: 'web',
      ip: '10.0.1.5',
      templateId: 'template-abc',
      osRequirement: { type: 'ubuntu', minVersion: '22.04' },
      services: [
        {
          id: 'svc-web',
          name: 'Web Service',
          role: 'web',
          installSteps: [
            { stepNumber: 1, description: 'Install web', command: 'echo Installing web; /tmp/install-web.sh', isPrerequisite: false }
          ],
          requiresConfigFrom: ['svc-db'],
          configKeys: [],
          ports: [{ port: 80, isPublic: true, description: 'HTTP' }],
          healthCheck: { type: 'http', target: '/health', timeoutSeconds: 5 },
        }
      ],
    },
    {
      id: 'vm-2',
      vmName: 'db-01',
      role: 'db',
      ip: '10.0.1.6',
      templateId: 'template-db',
      osRequirement: { type: 'ubuntu' },
      services: [
        {
          id: 'svc-db',
          name: 'Database',
          role: 'db',
          installSteps: [
            { stepNumber: 1, description: 'Install db', command: 'echo Installing db; /tmp/install-db.sh', isPrerequisite: false }
          ],
          requiresConfigFrom: [],
          configKeys: [ { key: 'DB_HOST', description: 'DB host' }, { key: 'DB_PORT', description: 'DB port' } ],
          ports: [{ port: 5432, isPublic: false, description: 'Postgres' }],
        }
      ],
    }
  ],
  ipAssignments: { 'svc-web': '10.0.1.5', 'svc-db': '10.0.1.6' },
  dependencyGraph: { deploymentOrder: ['svc-db', 'svc-web'] },
  mermaid: 'graph TD; A-->B',
};

const md = generateServiceRunbook('svc-web', design);
console.log('\n--- GENERATED RUNBOOK (markdown) ---\n');
console.log(md);

// extract bash code blocks
const blocks = [];
const regex = /```bash\n([\s\S]*?)```/g;
let m;
while ((m = regex.exec(md)) !== null) {
  blocks.push((m[1] || '').trim());
}

console.log('\n--- EXTRACTED SHELL SCRIPT (what will be appended to unified customization script) ---\n');
console.log(blocks.join('\n\n'));
console.log('\n--- END ---\n');
