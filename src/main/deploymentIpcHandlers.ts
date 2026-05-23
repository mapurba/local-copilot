import { BrowserWindow, ipcMain } from 'electron';
import http from 'http';
import {
  saveDeploymentPlan,
  loadDeploymentPlan,
  listDeploymentPlans,
  deleteDeploymentPlan,
  updateServiceStatus,
} from './deploymentStore';
import type { DeploymentPlan, ServiceStatus } from '../renderer/deploymentTypes';

const IP_POOL_API = 'http://164.99.91.31:5100/api/res-ip/free';

export function registerDeploymentIpcHandlers(mainWindow: BrowserWindow) {
  // Save deployment plan
  ipcMain.handle('deployment:savePlan', async (_event, plan: DeploymentPlan) => {
    try {
      saveDeploymentPlan(plan);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Load a specific deployment plan
  ipcMain.handle('deployment:loadPlan', async (_event, planId: string) => {
    try {
      const plan = loadDeploymentPlan(planId);
      if (!plan) return { success: false, error: 'Plan not found' };
      return { success: true, plan };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // List all deployment plans
  ipcMain.handle('deployment:listPlans', async () => {
    try {
      const plans = listDeploymentPlans();
      return { success: true, plans };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err), plans: [] };
    }
  });

  // Delete a deployment plan
  ipcMain.handle('deployment:deletePlan', async (_event, planId: string) => {
    try {
      const deleted = deleteDeploymentPlan(planId);
      return { success: deleted };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Update service status within a plan
  ipcMain.handle('deployment:updateServiceStatus', async (_event, input: {
    planId: string;
    serviceId: string;
    status: ServiceStatus;
    statusMessage?: string;
    deploymentLog?: string;
  }) => {
    try {
      const plan = updateServiceStatus(
        input.planId,
        input.serviceId,
        input.status,
        input.statusMessage,
        input.deploymentLog
      );
      if (!plan) return { success: false, error: 'Plan or service not found' };
      // Emit updated plan to renderer
      mainWindow.webContents.send('deployment:planUpdated', plan);
      return { success: true, plan };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Fetch free IPs from the IP pool API
  ipcMain.handle('deployment:fetchFreeIps', async (_event, count?: number) => {
    return new Promise((resolve) => {
      http.get(IP_POOL_API, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data) as { count: number; free_ips: Array<{ ip: string; hostname: string; available_since: string }> };
            const ips = parsed.free_ips || [];
            const requested = count && count > 0 ? ips.slice(0, count) : ips;
            resolve({ success: true, count: requested.length, ips: requested });
          } catch (err) {
            resolve({ success: false, error: `Failed to parse IP pool response: ${err instanceof Error ? err.message : String(err)}` });
          }
        });
      }).on('error', (err) => {
        resolve({ success: false, error: `IP pool API error: ${err.message}` });
      });
    });
  });

  // Emit deployment plan to the renderer (open Design/Deploy tab)
  ipcMain.handle('deployment:emitPlan', async (_event, plan: DeploymentPlan) => {
    try {
      saveDeploymentPlan(plan);
      mainWindow.webContents.send('deployment:planReady', plan);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
