// Full end-to-end test of the analysis pipeline using the real APIs
// Run: node test-full.mjs

process.env.WMIO_BASE_URL = 'https://dev6222501.m-yqb-c1.int.ipaas.dev.automation.ibm.com';
process.env.WMIO_API_KEY  = 'azI6ODJmOTEwMmUtYzMxYy00OTM3LTlhYjctMTFhMjJkZjY0NTFkOm1zaFZGekVqVWxWYjd5YlEydUVtMm9lVXpUVXYwQkpmeUo4WDVrWnNCcUk9';

const { analyzeRequest } = await import('./build/requestAnalyzer.js');

console.log('Analyzing: "Add Green label to card ABC in Trello"\n');
const result = await analyzeRequest('Add Green label to card ABC in Trello');
console.log(JSON.stringify(result, null, 2));
