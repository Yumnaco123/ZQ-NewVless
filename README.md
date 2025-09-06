# ZQ-NewVless
## 变量配置
可配置UUID
## 参数搭建



  * `/?mode=direct`（仅直连）
  * `/?mode=s5&s5=user:pass@host:port`（仅SOCKS5）
  * `/?mode=auto&direct&s5=user:pass@host:port`（直连优先，回退SOCKS5）
  * `/?mode=auto&direct&proxyip=host:port`（直连优先，回退ProxyIP）
  * `/?mode=auto&s5=user:pass@host:port&proxyip=host:port`（SOCKS5优先，回退ProxyIP）
  * `/?mode=auto&proxyip=host:port&s5=user:pass@host:port`（ProxyIP优先，回退SOCKS5）
  * `/?mode=auto&direct&s5=user:pass@host:port&proxyip=host:port`（三者都有：直连→SOCKS5→ProxyIP）
  * `/?mode=auto&s5=user:pass@host:port&proxyip=host:port&direct`（三者都有：SOCKS5→ProxyIP→直连）
  * `/?mode=auto&proxyip=host:port&s5=user:pass@host:port&direct`（三者都有：ProxyIP→SOCKS5→直连）
  * **上面只是示例，可自由搭配参数以满足不同场景需求**(不能使用`/?mode=proxy&proxyip=host:port`（仅ProxyIP）)
## 配置参考
![alt text](1.png)
![alt text](2.png)

