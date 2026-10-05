// Test the trigger-driven workflow request

process.env.WMIO_BASE_URL = 'https://dev6222501.m-yqb-c1.int.ipaas.dev.automation.ibm.com';
process.env.WMIO_API_KEY  = 'azI6ODJmOTEwMmUtYzMxYy00OTM3LTlhYjctMTFhMjJkZjY0NTFkOm1zaFZGekVqVWxWYjd5YlEydUVtMm9lVXpUVXYwQkpmeUo4WDVrWnNCcUk9';

const { analyzeRequest } = await import('./build/requestAnalyzer.js');

const request = 'when a new board is created in Trello, add label to card in board b15';
console.log(`Analyzing: "${request}"\n`);
const result = await analyzeRequest(request);
console.log(result.humanReadable);
console.log('\n--- JSON ---');
// Print without the long humanReadable field
const { humanReadable, ...rest } = result;
console.log(JSON.stringify(rest, null, 2));
