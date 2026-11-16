package douyin

// Node.js 定位：acrawler VMP 与 challenge 模板都要用 Node 执行 JS。
//
// 解析顺序（前者优先，命中即返回）：
//  1. `DY_NODE`（或 `DOUYIN_NODE`）显式指定；**一旦设置就以它为准，命中不了就视为没有 Node**，
//     便于固定环境/测试时避免意外回退；
//  2. PATH 上的 `node`；
//  3. `mise which node` —— 覆盖「Node 由 mise 管理、但没进 PATH」的常见情况
//     （本机就是如此：mise 有 node，但 PATH 里只有 mise 本身）。
//
// 都找不到时返回空串，调用方按原有逻辑给出「需要 Node.js」的明确错误。

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

// nodeResolveTimeout 限制 `mise which node` 的耗时，避免拖住请求。
const nodeResolveTimeout = 5 * time.Second

// resolveNode 返回可执行的 Node 二进制路径，找不到返回 ""。
func resolveNode() string {
	for _, key := range []string{"DY_NODE", "DOUYIN_NODE"} {
		if v := strings.TrimSpace(os.Getenv(key)); v != "" {
			if p, err := exec.LookPath(v); err == nil {
				return p
			}
			return ""
		}
	}
	if p, err := exec.LookPath("node"); err == nil {
		return p
	}
	if p := miseNode(); p != "" {
		return p
	}
	return ""
}

// miseNode asks mise for the Node it manages (`mise which node`).
func miseNode() string {
	mise, err := exec.LookPath("mise")
	if err != nil {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), nodeResolveTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, mise, "which", "node").Output()
	if err != nil {
		return ""
	}
	p := strings.TrimSpace(string(out))
	if p == "" {
		return ""
	}
	if fi, err := os.Stat(p); err != nil || fi.IsDir() {
		return ""
	}
	return p
}

// requireNode 返回 Node 路径或面向用户的错误（提示 DY_NODE / mise）。
func requireNode(purpose string) (string, error) {
	if p := resolveNode(); p != "" {
		return p, nil
	}
	return "", fmt.Errorf("Node.js is required for %s：请安装 Node（mise install node）或用 DY_NODE=<node 路径> 指定", purpose)
}
