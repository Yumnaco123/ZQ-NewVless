# ZQ-NewVless

轻量 Cloudflare Workers VLESS 搭建，支持直连、SOCKS5 回退与 ProxyIP 回退，并自带前端页面展示多种路径组合与复制按钮。

## 环境变量

| 名称 | 必填 | 默认值 | 示例 | 说明 |
| --- | --- | --- | --- | --- |
| UUID | 否 | 内置默认 | 38923c09-3a22-478e-9778-cf18f424b80e | VLESS 用户 ID |
| DOMAIN | 否 | 当前 Worker 域名 | newvle.vpnjacky.dpdns.org | 优选直连入口域名（address）。不填则使用 Worker 域名 |
| PORT | 否 | 443 | 8443 | 优选域名的端口（address 的端口） |
| S5 | 否 | - | user:pass@host:1080 或 host:1080 | SOCKS5 代理（支持带认证或无认证） |
| PROXY_IP | 否 | - | proxy.example.com:443 | 备用直连入口（host:port），无认证；用于回退 |
| URL | 否 | github.com/BAYUEQI/ZQ-NewVless| baidu.com |输入UUID不正确会跳转到这个网址|

重要行为：
- 链接中的 host 与 SNI 始终使用当前 Worker 域名（用于 TLS/SNI 与 WS Host）。
- 客户端连接的 address=DOMAIN、port=PORT（未设置则回落为 Worker 域名与 443）。

## 路径参数（前端会自动生成多种组合）

  * `/?mode=direct`（仅直连）
  * `/?mode=s5&s5=user:pass@host:port`（仅SOCKS5）
  * `/?mode=auto&direct&s5=user:pass@host:port`（直连优先，回退SOCKS5）
  * `/?mode=auto&s5=user:pass@host:port&direct`（SOCKS5优先，回退直连）
  * `/?mode=auto&direct&proxyip=host:port`（直连优先，回退ProxyIP）
  * `/?mode=auto&proxyip=host:port&direct`（ProxyIP优先，回退直连）
  * `/?mode=auto&s5=user:pass@host:port&proxyip=host:port`（SOCKS5优先，回退ProxyIP）
  * `/?mode=auto&proxyip=host:port&s5=user:pass@host:port`（ProxyIP优先，回退SOCKS5）
  * `/?mode=auto&direct&s5=user:pass@host:port&proxyip=host:port`（三者：直连→SOCKS5→ProxyIP）
  * `/?mode=auto&direct&proxyip=host:port&s5=user:pass@host:port`（三者：直连→ProxyIP→SOCKS5）
  * `/?mode=auto&s5=user:pass@host:port&direct&proxyip=host:port`（三者：SOCKS5→直连→ProxyIP）
  * `/?mode=auto&s5=user:pass@host:port&proxyip=host:port&direct`（三者：SOCKS5→ProxyIP→直连）
  * `/?mode=auto&proxyip=host:port&direct&s5=user:pass@host:port`（三者：ProxyIP→直连→SOCKS5）
  * `/?mode=auto&proxyip=host:port&s5=user:pass@host:port&direct`（三者：ProxyIP→SOCKS5→直连）

> 注意：不支持“仅 ProxyIP”模式。

## S5/PROXY_IP 填写规范

- S5：
  - 无认证：`host:port`
  - 带认证：`user:pass@host:port`
- PROXY_IP：`host:port` 或 `ip:port`或`ip`（不支持认证）

## 配置参考
![v2rayN](1.png)
![nekobox](2.png)
