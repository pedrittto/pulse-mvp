#!/usr/bin/env node

const { spawn, exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

const BACKEND_PORT = 4000;
const FRONTEND_PORT = 3000;

// Check if port is available
async function isPortAvailable(port) {
  try {
    const { stdout } = await execAsync(`netstat -an | findstr :${port}`);
    return !stdout.includes(`:${port}`);
  } catch {
    return true; // Port is available if command fails
  }
}

// Wait for port to be available
async function waitForPort(port, maxAttempts = 30) {
  for (let i = 0; i < maxAttempts; i++) {
    if (await isPortAvailable(port)) {
      return true;
    }
    console.log(`Waiting for port ${port} to be available... (${i + 1}/${maxAttempts})`);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return false;
}

// Start backend
function startBackend() {
  console.log('🚀 Starting backend...');
  const backend = spawn('npm', ['run', 'dev'], {
    cwd: './backend',
    stdio: 'inherit',
    shell: true
  });

  backend.on('error', (err) => {
    console.error('❌ Failed to start backend:', err);
    process.exit(1);
  });

  return backend;
}

// Start frontend
function startFrontend() {
  console.log('🎨 Starting frontend...');
  const frontend = spawn('npm', ['run', 'dev'], {
    cwd: './frontend',
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, PORT: FRONTEND_PORT }
  });

  frontend.on('error', (err) => {
    console.error('❌ Failed to start frontend:', err);
    process.exit(1);
  });

  return frontend;
}

// Main function
async function main() {
  console.log('🚀 Starting Pulse MVP development environment...\n');

  // Check if ports are already in use
  if (!(await isPortAvailable(BACKEND_PORT))) {
    console.error(`❌ Port ${BACKEND_PORT} is already in use. Please stop any existing backend process.`);
    console.error('💡 Run: npm run kill:4000 (in backend directory)');
    process.exit(1);
  }

  if (!(await isPortAvailable(FRONTEND_PORT))) {
    console.error(`❌ Port ${FRONTEND_PORT} is already in use. Please stop any existing frontend process.`);
    process.exit(1);
  }

  // Start backend
  const backend = startBackend();

  // Wait for backend to be ready
  console.log(`⏳ Waiting for backend to start on port ${BACKEND_PORT}...`);
  if (!(await waitForPort(BACKEND_PORT))) {
    console.error(`❌ Backend failed to start on port ${BACKEND_PORT}`);
    backend.kill();
    process.exit(1);
  }

  console.log('✅ Backend is ready!');

  // Start frontend
  const frontend = startFrontend();

  // Wait for frontend to be ready
  console.log(`⏳ Waiting for frontend to start on port ${FRONTEND_PORT}...`);
  if (!(await waitForPort(FRONTEND_PORT))) {
    console.error(`❌ Frontend failed to start on port ${FRONTEND_PORT}`);
    backend.kill();
    frontend.kill();
    process.exit(1);
  }

  console.log('✅ Frontend is ready!');
  console.log('\n🎉 Development environment started successfully!');
  console.log(`📱 Frontend: http://localhost:${FRONTEND_PORT}`);
  console.log(`🔧 Backend: http://localhost:${BACKEND_PORT}`);
  console.log('\n💡 Press Ctrl+C to stop all services');

  // Handle shutdown
  process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down development environment...');
    backend.kill();
    frontend.kill();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log('\n🛑 Shutting down development environment...');
    backend.kill();
    frontend.kill();
    process.exit(0);
  });
}

main().catch(console.error);
