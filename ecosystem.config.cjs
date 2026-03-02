module.exports = {
  apps: [
    {
      name: "conginstrument-api",
      script: "npm",
      args: "run start:api",
      cwd: "/home/ubuntu/conginstrument",
      env: {
        NODE_ENV: "production",
        PORT: "3001",
      },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
    },
  ],
};
