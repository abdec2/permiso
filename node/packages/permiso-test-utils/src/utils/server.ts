import { spawn, ChildProcess } from "child_process";
import { Logger, testLogger } from "./test-logger.js";

export interface TestServerOptions {
  port?: number;
  dbName?: string;
  maxRetries?: number;
  retryDelay?: number;
  logger?: Logger;
}

export class TestServer {
  private process: ChildProcess | null = null;
  private port: number;
  private dbName: string;
  private maxRetries: number;
  private retryDelay: number;
  private logger: Logger;

  constructor(options: TestServerOptions = {}) {
    this.port = options.port || 5002;
    this.dbName = options.dbName || "permiso_test";
    this.maxRetries = options.maxRetries || 30;
    this.retryDelay = options.retryDelay || 1000;
    this.logger = options.logger || testLogger;
  }

  private async killProcessOnPort(): Promise<void> {
    try {
      // Find process using the port
      const { execSync } = await import("child_process");
      const pid = execSync(`lsof -ti:${this.port} || true`).toString().trim();

      if (pid) {
        this.logger.debug(`Killing process ${pid} using port ${this.port}`);
        execSync(`kill -9 ${pid}`);
        // Wait a bit for the process to die
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } catch {
      // Ignore errors - port might already be free
    }
  }

  async start(): Promise<void> {
    // Kill any process using the port first
    await this.killProcessOnPort();

    return new Promise((resolve, reject) => {
      this.logger.info(
        `Starting test server on port ${this.port} with database ${this.dbName}`,
      );

      // Set environment variables for test server
      // Override the PERMISO database name for tests
      const env = {
        ...process.env,
        NODE_ENV: "test",
        PERMISO_SERVER_PORT: this.port.toString(),
        PERMISO_DB_HOST: process.env.PERMISO_DB_HOST || "localhost",
        PERMISO_DB_PORT: process.env.PERMISO_DB_PORT || "5432",
        PERMISO_DB_NAME: this.dbName, // Use test database
        // RLS database users - REQUIRED for all operations
        RLS_DB_USER: process.env.RLS_DB_USER || "rls_db_user",
        RLS_DB_USER_PASSWORD:
          process.env.RLS_DB_USER_PASSWORD || "changeme_rls_password",
        UNRESTRICTED_DB_USER:
          process.env.UNRESTRICTED_DB_USER || "unrestricted_db_user",
        UNRESTRICTED_DB_USER_PASSWORD:
          process.env.UNRESTRICTED_DB_USER_PASSWORD ||
          "changeme_admin_password",
        // Include API key settings if present
        PERMISO_API_KEY: process.env.PERMISO_API_KEY || "",
        PERMISO_API_KEY_ENABLED: process.env.PERMISO_API_KEY_ENABLED || "false",
      };

      // Start the server directly without shell script
      const serverPath = new URL(
        "../../../permiso-server/dist/bin/server.js",
        import.meta.url,
      ).pathname;

      this.process = spawn("node", [serverPath], {
        env,
        stdio: ["ignore", "pipe", "pipe"], // Capture both stdout and stderr
        cwd: new URL("../../../permiso-server/", import.meta.url).pathname,
      });

      let serverStarted = false;

      this.process.stdout?.on("data", (data) => {
        const output = data.toString();
        // Pass server output to test logger for debugging
        this.logger.debug("[SERVER]", output.trim());

        // Check if server is ready
        if (
          output.includes("GraphQL server running") ||
          output.includes("Server running at")
        ) {
          serverStarted = true;
          resolve(); // Resolve immediately when server is ready
        }
      });

      // Capture stderr for error output
      this.process.stderr?.on("data", (data) => {
        const output = data.toString();
        this.logger.error("[SERVER ERROR]", output.trim());
      });

      this.process.on("error", (error) => {
        this.logger.error("[SERVER PROCESS ERROR]", error);
        reject(error);
      });

      this.process.on("exit", (code) => {
        if (!serverStarted && code !== 0) {
          this.logger.error(`[SERVER EXIT] Server exited with code ${code}`);
          reject(new Error(`Server exited with code ${code}`));
        }
      });

      // Wait for server to be ready
      this.waitForServer()
        .then(() => {
          this.logger.info("Test server is ready");
          resolve();
        })
        .catch(reject);
    });
  }

  private async waitForServer(): Promise<void> {
    for (let i = 0; i < this.maxRetries; i++) {
      try {
        const response = await fetch(`http://localhost:${this.port}/graphql`, {
          method: "GET",
          headers: { Accept: "text/html" },
        });

        if (response.ok) {
          return;
        }
      } catch {
        // Server not ready yet
      }

      await new Promise((resolve) => setTimeout(resolve, this.retryDelay));
    }

    throw new Error(`Server failed to start after ${this.maxRetries} attempts`);
  }

  async stop(): Promise<void> {
    if (this.process) {
      return new Promise((resolve) => {
        let resolved = false;

        const cleanup = () => {
          if (!resolved) {
            resolved = true;
            this.process = null;
            resolve();
          }
        };

        // Set up exit handler
        this.process!.on("exit", cleanup);

        // Try graceful shutdown
        this.process!.kill("SIGTERM");

        // Force kill after 2 seconds and resolve
        setTimeout(async () => {
          if (this.process && !resolved) {
            this.process.kill("SIGKILL");
            // Also kill any process on the port just to be sure
            await this.killProcessOnPort();
            // Give it a moment to actually die
            setTimeout(cleanup, 100);
          }
        }, 2000);
      });
    }
  }
}
