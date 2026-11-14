/**
 * vitest 环境下 dsh-qdroid/robot 的解析替身：单测通过 setRobotModuleOverrideForTest
 * 注入替身模块，不真正加载已安装插件；这里是让 vite 静态分析能解析该可选依赖的最小占位。
 * 生产/组合环境不受影响（构建保持 external，由宿主解析真实的 dsh-qdroid）。
 */
export const qdroidRobotTestStub = true;
