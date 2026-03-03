const https = require('https');
require('dotenv').config();

const options = {
    hostname: 'epos.api.fena.co',
    path: '/open/company/bank-accounts/list',
    method: 'GET',
    headers: {
        'integration-id': process.env.FENA_TERMINAL_ID,
        'secret-key': process.env.FENA_TERMINAL_SECRET
    }
};

if (!process.env.FENA_TERMINAL_ID || !process.env.FENA_TERMINAL_SECRET) {
    console.error("FENA_TERMINAL_ID and FENA_TERMINAL_SECRET are required in your .env file!");
    process.exit(1);
}

const req = https.request(options, res => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
        try {
            const parsed = JSON.parse(data);
            if (!parsed.data || !parsed.data.docs) {
                console.error("Could not authenticate with Fena. Please check your credentials.");
                process.exit(1);
            }

            const sandbox = parsed.data.docs.find(d => d.isSandbox);
            if (sandbox) {
                console.log(`\nFound Sandbox Bank ID: ${sandbox.id}`);
                console.log(`Add this to your Medusa backend .env file:\n\nFENA_BANK_ACCOUNT_ID=${sandbox.id}\n`);
            } else {
                console.log('No Sandbox bank found for this account.');
            }
        } catch (e) { console.error('Error parsing response'); }
    });
});
req.on('error', e => console.error(e));
req.end();
