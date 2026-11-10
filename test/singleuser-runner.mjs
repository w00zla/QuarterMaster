// Test helper for singleuser.test.ts: runs the singleuser entry point and treats a line on stdin as SIGINT. Windows
// cannot deliver a catchable signal to a child process, so this is how the test reaches the shutdown handler there.
await import('../src/singleuser/main.ts');
process.stdin.on('data', () => process.emit('SIGINT'));
