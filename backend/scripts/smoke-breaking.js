#!/usr/bin/env node

const axios = require('axios');

const BASE_URL = process.env.BASE_URL || 'http://localhost:4000';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'test-admin-token';

async function smokeTest() {
  console.log('🚀 Starting Breaking Mode Smoke Test...\n');

  try {
    // 1. Check health endpoint
    console.log('1. Checking /health endpoint...');
    const healthResponse = await axios.get(`${BASE_URL}/health`);
    console.log('✅ Health endpoint OK');
    console.log(`   Breaking mode: ${healthResponse.data.breaking.mode}`);
    console.log(`   Sources: ${healthResponse.data.breaking.sources.length}`);
    
    // 2. Force re-ingest for 2-3 sources
    console.log('\n2. Testing /admin/reingest...');
    const reingestResponse = await axios.post(`${BASE_URL}/admin/reingest`, {
      sources: ['Bloomberg Breaking', 'CNBC Breaking'],
      force: true
    }, {
      headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` }
    });
    console.log('✅ Re-ingest scheduled');
    console.log(`   Scheduled: ${reingestResponse.data.scheduled.join(', ')}`);
    
    // 3. Wait 60 seconds
    console.log('\n3. Waiting 60 seconds for aggregation...');
    await new Promise(resolve => setTimeout(resolve, 60000));
    
    // 4. Check health again for stats
    console.log('\n4. Checking aggregated stats...');
    const healthResponse2 = await axios.get(`${BASE_URL}/health`);
    const sources = healthResponse2.data.breaking.sources;
    
    sources.forEach(source => {
      if (source.newInLast1m > 0 || source.duplicatesInLast1m > 0) {
        console.log(`   ${source.name}: new=${source.newInLast1m}, dupes=${source.duplicatesInLast1m}`);
      }
    });
    
    // 5. Reset breaking state
    console.log('\n5. Testing /admin/reset-breaking-state...');
    await axios.post(`${BASE_URL}/admin/reset-breaking-state`, {}, {
      headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` }
    });
    console.log('✅ Breaking state reset');
    
    console.log('\n🎉 Smoke test completed successfully!');
    
  } catch (error) {
    console.error('\n❌ Smoke test failed:');
    if (error.response) {
      console.error(`   Status: ${error.response.status}`);
      console.error(`   Data: ${JSON.stringify(error.response.data, null, 2)}`);
    } else {
      console.error(`   Error: ${error.message}`);
    }
    process.exit(1);
  }
}

// Run the smoke test
smokeTest();
