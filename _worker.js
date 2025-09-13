import {
	connect
} from 'cloudflare:sockets';

export default {
	async fetch(req, env) {
		

		// 从KV存储获取用户配置
		const getUserConfig = async () => {
			try {
				const config = await env.NewVless?.get('user_config', 'json');
				const merged = config || { uuid: 'ef9d104e-ca0e-4202-ba4b-a0afb969c747', domain: '', port: '443', s5: '', proxyIp: '', fallbackTimeout: '1000' };
				// 兼容老字段 proxyTimeout → fallbackTimeout
				if (!merged.fallbackTimeout && merged.proxyTimeout) merged.fallbackTimeout = merged.proxyTimeout;
				return merged;
			} catch {
				return { uuid: '882f016e-aa5b-4398-a39e-8d593300a760', domain: '', port: '443', s5: '', proxyIp: '', fallbackTimeout: '1000' };
			}
		};

		const buildVlessUri = (customRawPathQuery, uuid, label, workerHost, preferredDomain, port, s5, proxyIp) => {
			let rawPathQuery = customRawPathQuery;
			if (!rawPathQuery) {
				rawPathQuery = '/?mode=direct';
				if (s5 || proxyIp) {
					const params = [];
					params.push('mode=auto');
					params.push('direct');
					if (s5) params.push('s5=' + encodeURIComponent(String(s5)));
					if (proxyIp) params.push('proxyip=' + encodeURIComponent(String(proxyIp)));
					rawPathQuery = '/?' + params.join('&');
				}
			}
			const path = encodeURIComponent(rawPathQuery);
			const edge = preferredDomain;
			const tag = label ? String(label) : preferredDomain;
			return `vless://${uuid}@${edge}:${port}?encryption=none&security=tls&sni=${workerHost}&type=ws&host=${workerHost}&path=${path}#${encodeURIComponent(tag)}`;
		};

		const buildVariants = (s5, proxyIp) => {
			const variants = [];
			variants.push({ label: '仅直连', raw: '/?mode=direct' });
			if (s5) variants.push({ label: '仅SOCKS5', raw: `/?mode=s5&s5=${String(s5)}` });
			if (s5) variants.push({ label: '直连优先，回退SOCKS5', raw: `/?mode=auto&direct&s5=${String(s5)}` });
			if (s5) variants.push({ label: 'SOCKS5优先，回退直连', raw: `/?mode=auto&s5=${String(s5)}&direct` });
			if (proxyIp) variants.push({ label: '直连优先，回退ProxyIP', raw: `/?mode=auto&direct&proxyip=${String(proxyIp)}` });
			if (proxyIp) variants.push({ label: 'ProxyIP优先，回退直连', raw: `/?mode=auto&proxyip=${String(proxyIp)}&direct` });
			if (s5 && proxyIp) {
				variants.push({ label: 'SOCKS5优先，回退ProxyIP', raw: `/?mode=auto&s5=${String(s5)}&proxyip=${String(proxyIp)}` });
				variants.push({ label: 'ProxyIP优先，回退SOCKS5', raw: `/?mode=auto&proxyip=${String(proxyIp)}&s5=${String(s5)}` });
				variants.push({ label: '直连→SOCKS5→ProxyIP', raw: `/?mode=auto&direct&s5=${String(s5)}&proxyip=${String(proxyIp)}` });
				variants.push({ label: '直连→ProxyIP→SOCKS5', raw: `/?mode=auto&direct&proxyip=${String(proxyIp)}&s5=${String(s5)}` });
				variants.push({ label: 'SOCKS5→直连→ProxyIP', raw: `/?mode=auto&s5=${String(s5)}&direct&proxyip=${String(proxyIp)}` });
				variants.push({ label: 'SOCKS5→ProxyIP→直连', raw: `/?mode=auto&s5=${String(s5)}&proxyip=${String(proxyIp)}&direct` });
				variants.push({ label: 'ProxyIP→直连→SOCKS5', raw: `/?mode=auto&proxyip=${String(proxyIp)}&direct&s5=${String(s5)}` });
				variants.push({ label: 'ProxyIP→SOCKS5→直连', raw: `/?mode=auto&proxyip=${String(proxyIp)}&s5=${String(s5)}&direct` });
			}
			return variants;
		};

		const getHostAndPort = (request, cfg) => {
			const workerHost = new URL(request.url).hostname;
			const preferred = cfg.domain || workerHost;
			const port = +(cfg.port || 443);
			return { workerHost, preferred, port };
		};

		const text = (body, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });

		const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });


		if (req.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
			const [client, ws] = Object.values(new WebSocketPair());
			ws.accept();

			// Get user config for WebSocket connections
			const userConfig = await getUserConfig();

			const u = new URL(req.url);
			const mode = u.searchParams.get('mode') || 'auto';
			const s5Param = u.searchParams.get('s5');
			const proxyParam = u.searchParams.get('proxyip');
			const path = s5Param ? s5Param : u.pathname.slice(1);
			const PROXY_FIRST_BYTE_TIMEOUT_MS = +(userConfig.fallbackTimeout || 1000);

			// 解析SOCKS5和ProxyIP（支持 user:pass@host:port 或 host:port）
			const socks5 = (() => {
				const src = s5Param || '';
				if (!src) return null;
				if (src.includes('@')) {
					const [cred, server] = src.split('@');
				const [user, pass] = cred.split(':');
				const [host, port = 443] = server.split(':');
					return { user, pass, host, port: +port };
				}
				const [host, port = 443] = src.split(':');
				if (!host) return null;
				return { user: '', pass: '', host, port: +port };
			})();
			const PROXY_IP = proxyParam ? String(proxyParam) : null;

			// auto模式参数顺序（按URL参数位置）
			const getOrder = () => {
				if (mode === 'proxy') return ['direct', 'proxy'];
				if (mode !== 'auto') return [mode];
				const order = [];
				const searchStr = u.search.slice(1);
				for (const pair of searchStr.split('&')) {
					const key = pair.split('=')[0];
					if (key === 'direct') order.push('direct');
					else if (key === 's5') order.push('s5');
					else if (key === 'proxyip') order.push('proxy');
				}
				return order;
			};

			let remote = null,
				udpWriter = null,
				isDNS = false;

			// SOCKS5连接
			const socks5Connect = async (targetHost, targetPort) => {
				const sock = connect({
					hostname: socks5.host,
					port: socks5.port
				});
				await sock.opened;
				const w = sock.writable.getWriter();
				const r = sock.readable.getReader();
				// 请求方法: 无认证(0x00) 与 用户名口令(0x02)
				await w.write(new Uint8Array([5, 2, 0, 2]));
				const auth = (await r.read()).value;
				if (auth[1] === 2 && socks5.user && socks5.user.length > 0) {
					const user = new TextEncoder().encode(socks5.user);
					const pass = new TextEncoder().encode(socks5.pass);
					await w.write(new Uint8Array([1, user.length, ...user, pass.length, ...pass]));
					await r.read();
				}
				const domain = new TextEncoder().encode(targetHost);
				await w.write(new Uint8Array([5, 1, 0, 3, domain.length, ...domain, targetPort >> 8,
					targetPort & 0xff
				]));
				await r.read();
				w.releaseLock();
				r.releaseLock();
				return sock;
			};

			new ReadableStream({
				start(ctrl) {
					ws.addEventListener('message', e => ctrl.enqueue(e.data));
					ws.addEventListener('close', () => {
						remote?.close();
						ctrl.close();
					});
					ws.addEventListener('error', () => {
						remote?.close();
						ctrl.error();
					});

					const early = req.headers.get('sec-websocket-protocol');
					if (early) {
						try {
							ctrl.enqueue(Uint8Array.from(atob(early.replace(/-/g, '+').replace(/_/g, '/')),
								c => c.charCodeAt(0)).buffer);
						} catch {}
					}
				}
			}).pipeTo(new WritableStream({
				async write(data) {
					if (isDNS) return udpWriter?.write(data);
					if (remote) {
						const w = remote.writable.getWriter();
						await w.write(data);
						w.releaseLock();
						return;
					}

					if (data.byteLength < 24) return;

					// UUID验证
					const uuidBytes = new Uint8Array(data.slice(1, 17));
					const expectedUUID = userConfig.uuid.replace(/-/g, '');
					for (let i = 0; i < 16; i++) {
						if (uuidBytes[i] !== parseInt(expectedUUID.substr(i * 2, 2), 16)) return;
					}

					const view = new DataView(data);
					const optLen = view.getUint8(17);
					const cmd = view.getUint8(18 + optLen);
					if (cmd !== 1 && cmd !== 2) return;

					let pos = 19 + optLen;
					const port = view.getUint16(pos);
					const type = view.getUint8(pos + 2);
					pos += 3;

					let addr = '';
					if (type === 1) {
						addr =
							`${view.getUint8(pos)}.${view.getUint8(pos + 1)}.${view.getUint8(pos + 2)}.${view.getUint8(pos + 3)}`;
						pos += 4;
					} else if (type === 2) {
						const len = view.getUint8(pos++);
						addr = new TextDecoder().decode(data.slice(pos, pos + len));
						pos += len;
					} else if (type === 3) {
						const ipv6 = [];
						for (let i = 0; i < 8; i++, pos += 2) ipv6.push(view.getUint16(pos)
							.toString(16));
						addr = ipv6.join(':');
					} else return;

					const header = new Uint8Array([data[0], 0]);
					const payload = data.slice(pos);

					// UDP DNS
					if (cmd === 2) {
						if (port !== 53) return;
						isDNS = true;
						let sent = false;
						const {
							readable,
							writable
						} = new TransformStream({
							transform(chunk, ctrl) {
								for (let i = 0; i < chunk.byteLength;) {
									const len = new DataView(chunk.slice(i, i + 2))
										.getUint16(0);
									ctrl.enqueue(chunk.slice(i + 2, i + 2 + len));
									i += 2 + len;
								}
							}
						});

						readable.pipeTo(new WritableStream({
							async write(query) {
								try {
									const resp = await fetch(
										'https://1.1.1.1/dns-query', {
											method: 'POST',
											headers: {
												'content-type': 'application/dns-message'
											},
											body: query
										});
									if (ws.readyState === 1) {
										const result = new Uint8Array(await resp
											.arrayBuffer());
										ws.send(new Uint8Array([...(sent ? [] :
												header), result
											.length >> 8, result
											.length & 0xff, ...result
										]));
										sent = true;
									}
								} catch {}
							}
						}));
						udpWriter = writable.getWriter();
						return udpWriter.write(payload);
					}

					// TCP连接（统一首字节探测与回退规则）
					let sock = null;
					let handledInline = false;
					const probeAndAdopt = async (tentative) => {
								const tw = tentative.writable.getWriter();
								await tw.write(payload);
								tw.releaseLock();
								const reader = tentative.readable.getReader();
								let first;
								try {
									first = await Promise.race([
										reader.read(),
										new Promise(resolve => setTimeout(() => resolve({ timeout: true }), PROXY_FIRST_BYTE_TIMEOUT_MS))
									]);
								} catch {}
								if (!first || first.timeout || first.done || !first.value || first.value.byteLength === 0) {
									try { reader.releaseLock(); } catch {}
									try { tentative.close(); } catch {}
							return false;
								}
									const chunk = new Uint8Array(first.value);
						const looksHTTP = chunk.length >= 5 && chunk[0] === 0x48 && chunk[1] === 0x54 && chunk[2] === 0x54 && chunk[3] === 0x50 && chunk[4] === 0x2f;
						const looksHTML = chunk.length >= 1 && (chunk[0] === 0x3c);
						const isTLSAlert = chunk.length >= 1 && chunk[0] === 0x15;
									if (looksHTTP || looksHTML || isTLSAlert) {
										try { reader.releaseLock(); } catch {}
										try { tentative.close(); } catch {}
							return false;
								}
								sock = tentative;
								remote = sock;
						if (ws.readyState === 1) ws.send(new Uint8Array([...header, ...chunk]));
								(async () => {
									try {
										for (;;) {
											const { value, done } = await reader.read();
											if (done) break;
											if (ws.readyState === 1) ws.send(value);
										}
									} catch {}
							finally { ws.readyState === 1 && ws.close(); }
								})();
								handledInline = true;
						return true;
					};
					for (const method of getOrder()) {
						try {
							if (method === 'direct') {
								const tentative = connect({ hostname: addr, port });
								await tentative.opened;
								if (await probeAndAdopt(tentative)) break; else continue;
							} else if (method === 's5' && socks5) {
								const tentative = await socks5Connect(addr, port);
								if (await probeAndAdopt(tentative)) break; else continue;
							} else if (method === 'proxy' && PROXY_IP) {
								const [ph, pp = port] = PROXY_IP.split(':');
								const tentative = connect({ hostname: ph, port: +pp || port });
								await tentative.opened;
								if (await probeAndAdopt(tentative)) break; else continue;
							}
						} catch {}
					}

					if (!sock) return;

					if (handledInline) {
						return;
					}

					remote = sock;
					const w = sock.writable.getWriter();
					await w.write(payload);
					w.releaseLock();

					let sent = false;
					sock.readable.pipeTo(new WritableStream({
						write(chunk) {
							if (ws.readyState === 1) {
								ws.send(sent ? chunk : new Uint8Array([...header, ...
									new Uint8Array(chunk)
								]));
								sent = true;
							}
						},
						close: () => ws.readyState === 1 && ws.close(),
						abort: () => ws.readyState === 1 && ws.close()
					})).catch(() => {});
				}
			})).catch(() => {});

			return new Response(null, {
				status: 101,
				webSocket: client
			});
		}

		const url = new URL(req.url);

		// 纯文本订阅：/subraw/{UUID} or /subraw?uuid=
		if (url.pathname.startsWith('/subraw')) {
			const parts = url.pathname.split('/').filter(p => p);
			const inputUUID = url.searchParams.get('uuid') || parts[1];
			if (!inputUUID) return text('missing uuid', 400);
			const userConfig = await getUserConfig();
			if (inputUUID !== userConfig.uuid) return text('UUID错误，请检查后重新输入', 400);
			const { workerHost, preferred, port } = getHostAndPort(req, userConfig);
			const variants = buildVariants(userConfig.s5, userConfig.proxyIp);
			const lines = variants.map(v => buildVlessUri(v.raw, userConfig.uuid, v.label, workerHost, preferred, port, userConfig.s5, userConfig.proxyIp)).join('\n');
			return text(lines + '\n');
		}

		if (url.pathname === '/api/config') {
			if (req.method === 'GET') {
				const config = await getUserConfig();
				return json(config);
			} else if (req.method === 'POST') {
				try {
					const newConfig = await req.json();
					if (!newConfig.uuid || typeof newConfig.uuid !== 'string') {
						return json({ error: 'UUID不能为空' }, 400);
					}
					if (env.NewVless) {
						await env.NewVless.put('user_config', JSON.stringify(newConfig));
					}
					return json({ success: true, message: '配置保存成功' });
				} catch (error) {
					return json({ error: '配置保存失败' }, 500);
				}
			}
		}

		if (url.pathname.startsWith('/config/')) {
			const configParts = url.pathname.split('/').filter(p => p);
			if (configParts.length === 2 && configParts[0] === 'config') {
				const inputUUID = configParts[1];
				const userConfig = await getUserConfig();
				if (inputUUID !== userConfig.uuid) {
					return new Response('UUID错误，无权访问配置管理', { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } });
				}
				const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>配置管理 - ZQ-NewVless</title><link rel="icon" type="image/png" href="https://img.520jacky.dpdns.org/i/2025/06/03/551258.png"><style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;margin:0;background:#0b1020;color:#e6e9ef;min-height:100vh;padding:20px}.container{max-width:800px;margin:0 auto}.card{background:#12182e;border:1px solid #24304f;border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.35);padding:32px;margin-bottom:20px}h1{margin:0 0 20px;font-size:24px;text-align:center}.form-group{margin-bottom:20px}label{display:block;margin-bottom:8px;font-weight:600}input[type="text"],input[type="number"]{width:100%;padding:12px;border:1px solid #24304f;border-radius:8px;background:#0e1427;color:#e6e9ef;font-size:16px;box-sizing:border-box}input[type="text"]:focus,input[type="number"]:focus{outline:none;border-color:#2f6fed}.button-group{display:flex;gap:12px;flex-wrap:wrap}button{background:#2f6fed;color:#fff;border:none;border-radius:8px;padding:12px 24px;font-size:16px;font-weight:600;cursor:pointer;flex:1;min-width:120px}button:hover{background:#1e5bb8}button.secondary{background:#24304f}button.secondary:hover{background:#2a3a5a}.message{margin-top:12px;padding:12px;border-radius:8px;text-align:center;font-size:14px}.success{background:#1a4d1a;border:1px solid #2d7a2d;color:#90ee90}.error{background:#4d1a1a;border:1px solid #7a2d2d;color:#ff6b6b}.back-link{display:inline-flex;align-items:center;gap:8px;color:#2f6fed;text-decoration:none;margin-bottom:20px}.back-link:hover{text-decoration:underline}.chip{padding:6px 10px;font-size:12px;min-width:auto;flex:none}.spinner{display:inline-block;width:12px;height:12px;border:2px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;animation:spin .8s linear infinite;margin-right:6px;vertical-align:-2px}@keyframes spin{to{transform:rotate(360deg)}}</style></head><body><div class="container"><a href="/${userConfig.uuid}" class="back-link">← 返回节点界面</a><div class="card"><h1>配置管理</h1><form id="configForm"><div class="form-group"><label for="uuid">UUID</label><input type="text" id="uuid" name="uuid" required placeholder="请输入UUID"></div><div class="form-group"><label for="domain">优选域名(可选)</label><input type="text" id="domain" name="domain" placeholder="自定义域名"></div><div class="form-group"><label for="port">端口(可选)</label><input type="number" id="port" name="port" value="443" min="1" max="65535"></div><div class="form-group"><label for="s5">SOCKS5代理 (可选)</label><div style="display:flex;gap:8px;"><input type="text" id="s5" name="s5" placeholder="格式: user:pass@host:port或host:port" style="flex:1;"><button type="button" id="probeS5" class="secondary chip">检测</button></div></div><div class="form-group"><label for="proxyIp">ProxyIP (可选)</label><div style="display:flex;gap:8px;"><input type="text" id="proxyIp" name="proxyIp" placeholder="格式: host:port或host" style="flex:1;"><button type="button" id="probeProxy" class="secondary chip">检测</button></div></div><div class="form-group"><label for="fallbackTimeout">回退探测时间(毫秒)</label><input type="number" id="fallbackTimeout" name="fallbackTimeout" value="1000" min="100" max="10000"></div><div class="button-group"><button type="submit">保存配置</button><button type="button" class="secondary" onclick="loadConfig()">重新加载</button></div><div id="message" class="message" style="display:none"></div></form></div></div><script>async function loadConfig(){try{const response=await fetch('/api/config');if(response.ok){const config=await response.json();document.getElementById('uuid').value=config.uuid||'';document.getElementById('domain').value=config.domain||'';document.getElementById('port').value=config.port||443;document.getElementById('s5').value=config.s5||'';document.getElementById('proxyIp').value=config.proxyIp||'';document.getElementById('fallbackTimeout').value=(config.fallbackTimeout||config.proxyTimeout||1000);showMessage('配置加载成功','success');}else{showMessage('配置加载失败','error');}}catch(error){showMessage('配置加载失败','error');}}async function saveConfig(formData){try{const config={uuid:formData.get('uuid'),domain:formData.get('domain'),port:formData.get('port'),s5:formData.get('s5'),proxyIp:formData.get('proxyIp'),fallbackTimeout:formData.get('fallbackTimeout')};const response=await fetch('/api/config',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(config)});const result=await response.json();if(response.ok){showMessage(result.message||'配置保存成功','success');}else{showMessage(result.error||'配置保存失败','error');}}catch(error){showMessage('配置保存失败','error');}}function showMessage(text,type){const messageDiv=document.getElementById('message');messageDiv.textContent=text;messageDiv.className='message '+type;messageDiv.style.display='block';setTimeout(()=>{messageDiv.style.display='none';},3000);}document.addEventListener('DOMContentLoaded',()=>{const s5Btn=document.getElementById('probeS5');const pxBtn=document.getElementById('probeProxy');const runProbe=async(btn, url, label)=>{if(!btn)return;const orig=btn.innerHTML;btn.disabled=true;btn.innerHTML='<span class="spinner"></span>'+label;let res;try{const r=await fetch(url);res=await r.json();}catch{res={ok:false,message:'接口错误'};}btn.disabled=false;btn.innerHTML='检测';return res;};if(s5Btn){s5Btn.addEventListener('click', async (e)=>{e.preventDefault();const tEl=document.getElementById('fallbackTimeout');const timeout=Number(tEl&&tEl.value)||1000;const valEl=document.getElementById('s5');const val=(valEl&&valEl.value||'').trim();const q= val?('&s5='+encodeURIComponent(val)):'';const res=await runProbe(s5Btn, '/api/probe?type=s5&timeout='+timeout+q, '检测中');showMessage('SOCKS5：'+(res.ok?'可用':'不可用')+'（'+(res.ms||'-')+'ms） '+(res.message||''),res.ok?'success':'error');});}
if(pxBtn){pxBtn.addEventListener('click', async (e)=>{e.preventDefault();const tEl=document.getElementById('fallbackTimeout');const timeout=Number(tEl&&tEl.value)||1000;const valEl=document.getElementById('proxyIp');const val=(valEl&&valEl.value||'').trim();const q= val?('&proxyip='+encodeURIComponent(val)):'';const res=await runProbe(pxBtn, '/api/probe?type=proxyip&timeout='+timeout+q, '检测中');showMessage('ProxyIP：'+(res.ok?'可用':'不可用')+'（'+(res.ms||'-')+'ms） '+(res.message||''),res.ok?'success':'error');});}});document.getElementById('configForm').addEventListener('submit',function(e){e.preventDefault();const formData=new FormData(this);saveConfig(formData);});loadConfig();</script></body></html>`;
				return new Response(html, {headers:{'content-type':'text/html; charset=utf-8'}});
			}
		}

		if (url.pathname === '/api/probe') {
			const params = url.searchParams;
			const type = params.get('type');
			const tStr = params.get('timeout');
			const timeoutMs = Math.max(50, Math.min(20000, +(tStr || 0) || (await getUserConfig()).fallbackTimeout || 1000));
			const started = Date.now();
			try {
				if (type === 'proxyip') {
					const raw = params.get('proxyip') || (await getUserConfig()).proxyIp || '';
					if (!raw) return json({ ok: false, ms: 0, message: '未填写 ProxyIP' }, 400);
					const [host, p] = raw.split(':');
					const port = +(p || 443);
					const sock = connect({ hostname: host, port });
					const openRes = await Promise.race([sock.opened.then(()=> 'ok'), new Promise((r)=>setTimeout(()=>r('timeout'), timeoutMs))]);
					if (openRes !== 'ok') { try{sock.close();}catch{} return json({ ok:false, ms: Date.now()-started, message:'连接超时' }, 408); }
					try{sock.close();}catch{}
					return json({ ok:true, ms: Date.now()-started, message:'可用' });
				}
				if (type === 's5') {
					const raw = params.get('s5') || (await getUserConfig()).s5 || '';
					if (!raw) return json({ ok: false, ms: 0, message: '未填写 SOCKS5' }, 400);
					// parse s5
					let user='', pass='', host='', port=443;
					if (raw.includes('@')) { const [cred, server] = raw.split('@'); [user, pass] = cred.split(':'); [host, port] = server.split(':'); }
					else { [host, port] = raw.split(':'); }
					port = +(port||443);
					const sock = connect({ hostname: host, port });
					await Promise.race([sock.opened, new Promise((r)=>setTimeout(()=>r('timeout'), timeoutMs))]);
					const w = sock.writable.getWriter();
					const r = sock.readable.getReader();
					await w.write(new Uint8Array([5, 2, 0, 2]));
					const methodResp = await Promise.race([r.read(), new Promise((r2)=>setTimeout(()=>r2({ timeout:true } ), timeoutMs))]);
					if (!methodResp || methodResp.timeout || !methodResp.value) { try{r.releaseLock(); w.releaseLock(); sock.close();}catch{} return json({ ok:false, ms: Date.now()-started, message:'握手超时' }, 408); }
					if (methodResp.value[1] === 2 && user) {
						const ue = new TextEncoder().encode(user);
						const pe = new TextEncoder().encode(pass||'');
						await w.write(new Uint8Array([1, ue.length, ...ue, pe.length, ...pe]));
						await r.read();
					}
					const dom = new TextEncoder().encode('example.com');
					await w.write(new Uint8Array([5,1,0,3,dom.length, ...dom, 443>>8, 443 & 0xff]));
					const connResp = await Promise.race([r.read(), new Promise((r2)=>setTimeout(()=>r2({ timeout:true } ), timeoutMs))]);
					try{r.releaseLock(); w.releaseLock(); sock.close();}catch{}
					if (!connResp || connResp.timeout || !connResp.value) return json({ ok:false, ms: Date.now()-started, message:'CONNECT 超时' }, 408);
					return json({ ok:true, ms: Date.now()-started, message:'可用' });
				}
				return json({ ok:false, ms:0, message:'type 参数无效' }, 400);
			} catch (e) {
				return json({ ok:false, ms: Date.now()-started, message:'探测失败' }, 500);
			}
		}

		// v2rayN subscription: /sub/{UUID} or /sub?uuid=...
		if (url.pathname.startsWith('/sub')) {
			const parts = url.pathname.split('/').filter(p => p);
			const inputUUID = url.searchParams.get('uuid') || parts[1];
			if (!inputUUID) return text('missing uuid', 400);
			
			// Get user config
			const userConfig = await getUserConfig();
			if (inputUUID !== userConfig.uuid) return text('UUID错误，请检查后重新输入', 400);
			const { workerHost, preferred, port } = getHostAndPort(req, userConfig);
			const variants = buildVariants(userConfig.s5, userConfig.proxyIp);
			const lines = variants.map(v => buildVlessUri(v.raw, userConfig.uuid, v.label, workerHost, preferred, port, userConfig.s5, userConfig.proxyIp)).join('\n');
			const b64 = btoa(unescape(encodeURIComponent(lines)));
			return text(b64 + '\n');
		}

		// UUID input interface at root
		if (url.pathname === '/' || url.pathname === '/index.html') {
			const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ZQ-NewVless</title><link rel="icon" type="image/png" href="https://img.520jacky.dpdns.org/i/2025/06/03/551258.png"><style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;margin:0;background:#0b1020;color:#e6e9ef;display:flex;min-height:100vh;align-items:center;justify-content:center}.card{background:#12182e;border:1px solid #24304f;border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.35);max-width:500px;width:90%;padding:32px}h1{margin:0 0 20px;font-size:24px;text-align:center}.form-group{margin-bottom:20px}label{display:block;margin-bottom:8px;font-weight:600}input[type="text"]{width:100%;padding:12px;border:1px solid #24304f;border-radius:8px;background:#0e1427;color:#e6e9ef;font-size:16px;box-sizing:border-box}input[type="text"]:focus{outline:none;border-color:#2f6fed}button{width:100%;background:#2f6fed;color:#fff;border:none;border-radius:8px;padding:12px;font-size:16px;font-weight:600;cursor:pointer}button:hover{background:#1e5bb8}.error{margin-top:12px;color:#ff6b6b;text-align:center;font-size:14px}</style></head><body><div class="card"><h1>ZQ-NewVless</h1><form method="get"><div class="form-group"><label for="uuid">请输入UUID</label><input type="text" id="uuid" name="uuid" required placeholder="请输入正确的UUID"></div><button type="submit">进入节点界面</button></form><div class="error" id="error" style="display:none">UUID错误，请检查后重新输入</div></div><script>document.querySelector('form').addEventListener('submit',function(e){e.preventDefault();const uuid=document.getElementById('uuid').value.trim();if(!uuid)return;fetch('/' + uuid).then(response=>{if(response.ok){window.location.href='/' + uuid;}else{const errorDiv=document.getElementById('error');errorDiv.style.display='block';errorDiv.textContent='UUID错误，请检查后重新输入';}}).catch(()=>{const errorDiv=document.getElementById('error');errorDiv.style.display='block';errorDiv.textContent='UUID错误，请检查后重新输入';});});</script></body></html>`;
			return new Response(html, {headers:{'content-type':'text/html; charset=utf-8'}});
		}

		// Node interface at /{UUID}
		const pathParts = url.pathname.split('/').filter(p => p);
		if (pathParts.length === 1) {
			const inputUUID = pathParts[0];
			
			// Get user config
			const userConfig = await getUserConfig();
			
			// Check if input UUID matches user config UUID
			if (inputUUID !== userConfig.uuid) {
				return new Response('UUID错误，请检查后重新输入', { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' } });
			}

			// Use user config UUID
			const userUUID = userConfig.uuid;
			
			// Build subscription URL for frontend display
			const origin = new URL(req.url).origin;
			const subUrl = `${origin}/sub/${userUUID}`;
			
			const { workerHost: workerHost2, preferred: preferred2, port: port2 } = getHostAndPort(req, userConfig);
			const variants = buildVariants(userConfig.s5, userConfig.proxyIp);
			const itemsHtml = variants.map(v=>{
				const full = buildVlessUri(v.raw, userUUID, v.label, workerHost2, preferred2, port2, userConfig.s5, userConfig.proxyIp);
				return `<div class="item"><div class="label">${v.label}</div><div class="box">${full}</div><div class="row"><button class="copy" data-text="${full.replace(/"/g,'&quot;')}">复制</button></div></div>`;
			}).join('');
			const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ZQ-NewVless</title><link rel="icon" type="image/png" href="https://img.520jacky.dpdns.org/i/2025/06/03/551258.png"><style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,'Apple Color Emoji','Segoe UI Emoji';margin:0;background:#0b1020;color:#e6e9ef} .wrap{max-width:980px;margin:0 auto;padding:24px;position:relative} h1{margin:4px 0 12px;font-size:22px} .topbar{position:absolute;right:24px;top:24px;display:flex;gap:8px} .gh{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:50%;background:#12182e;border:1px solid #24304f;color:#e6e9ef;text-decoration:none} .gh:hover{background:#1a2240} .config-btn{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:50%;background:#12182e;border:1px solid #24304f;color:#e6e9ef;text-decoration:none;font-size:16px} .config-btn:hover{background:#1a2240} .speed-btn{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:50%;background:#12182e;border:1px solid #24304f;color:#e6e9ef;text-decoration:none;font-size:16px} .speed-btn:hover{background:#1a2240} .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:14px} .item{background:#12182e;border:1px solid #24304f;border-radius:12px;padding:14px} .label{font-weight:700;margin-bottom:8px} .box{background:#0e1427;border:1px solid #24304f;border-radius:8px;padding:12px;word-break:break-all;font-size:12px} .row{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap} button, a.btn{background:#2f6fed;color:#fff;border:none;border-radius:8px;padding:8px 12px;font-weight:600;cursor:pointer;text-decoration:none;font-size:14px}</style></head><body><div class="wrap"><div class="topbar"><a class="speed-btn" href="https://ipspeed.520jacky.dpdns.org/index.html" target="_blank" rel="nofollow noopener" title="优选域名和ProxyIP">🌐</a><a class="speed-btn" href="https://sublink.vpnjacky.dpdns.org" target="_blank" rel="nofollow noopener" title="订阅链接转换">🔗</a><a class="config-btn" href="/config/${userUUID}" title="配置管理">⚙️</a><a class="gh" href="https://github.com/BAYUEQI/ZQ-NewVless" target="_blank" rel="nofollow noopener" aria-label="GitHub 项目"><svg viewBox="0 0 16 16" width="20" height="20" aria-hidden="true" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"></path></svg></a></div><h1>ZQ-NewVless</h1><div class="item"><div class="label">订阅链接</div><div class="box">${subUrl}</div><div class="row"><button class="copy" data-text="${subUrl}">复制链接</button><a class="btn" href="${subUrl}" target="_blank" rel="nofollow noopener">查看订阅</a><a class="btn" href="/subraw/${userUUID}" target="_blank" rel="nofollow noopener">节点信息</a></div></div><div class="grid">${itemsHtml}</div></div><script>(function(){function fallbackCopy(text){const ta=document.createElement('textarea');ta.value=text;ta.setAttribute('readonly','');ta.style.position='absolute';ta.style.left='-9999px';document.body.appendChild(ta);ta.select();let ok=false;try{ok=document.execCommand('copy');}catch(e){}document.body.removeChild(ta);return ok;}async function doCopy(btn){const t=btn.getAttribute('data-text');if(!t)return;let ok=false;if(navigator.clipboard&&navigator.clipboard.writeText){try{await navigator.clipboard.writeText(t);ok=true;}catch(e){ok=false;}}if(!ok){ok=fallbackCopy(t);}btn.textContent= ok ? '已复制' : '复制失败';setTimeout(()=>btn.textContent='复制链接',1400);}document.querySelectorAll('button.copy').forEach(b=>b.addEventListener('click',e=>{doCopy(e.currentTarget);}));})();</script></body></html>`;
			return new Response(html, {headers:{'content-type':'text/html; charset=utf-8'}});
		}



		// Default behaviour: proxy normal HTTP requests (keeps worker minimal)
		url.hostname = 'example.com';
		return fetch(new Request(url, req));
	}
};
