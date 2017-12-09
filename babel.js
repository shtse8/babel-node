const path = require('path')
const os = require('os')
const fs = require('fs')
const cp = require('child_process')
const util = require('util')
const _module = require('module')
const chalk = require('chalk')
const Netlinkwrapper  = require('netlinkwrapper')
const net = require('net')
const EventEmitter = require('events')
const babel = require('@babel/core')
const eslint = require('eslint')
const crypto = require('crypto')
const commander = require('commander')
const sourceMapSupport = require('source-map-support')
const chokidar = require('chokidar')
const _ = require('lodash')
const shell = require('shelljs')
const portfinder = require('portfinder')
const cwd = process.cwd()
const NS_PER_SEC = 1e9

process.on('unhandledRejection', (error, promise) => {
  throw error
})

class Socket {
  constructor (handler) {
    this.handler = handler || (x => x)
    this.socket = this._create()
    this.buffer = new String()
    this.eventEmitter = new EventEmitter()
  }

  _create () {
    let socket = new net.Socket()
    socket.on('data', (chunk) => {
      this._processChunk(chunk)
      let message
      while (message = this._processMessage()) {
        this.eventEmitter.emit('message', this.handler(message))
      }
    })
    return socket
  }

  _processChunk (chunk) {
    if (chunk) {
      // this.display('received chunk', bufferName, chunk)
      this.buffer += chunk
    }
  }

  _processMessage () {
    let pos
    while ((pos = this.buffer.indexOf('\n')) !== -1) {
      let message = this.buffer.substr(0, pos)
      this.buffer = this.buffer.substr(pos + 1)
      message = JSON.parse(message)
      if (message) {
        // this.display('message', message)
        return message
      }
    }
  }

  connect (port, host) {
    this.socket.connect(port, host)
  }

  write (data) {
    try {
      this.socket.write(JSON.stringify(data) + '\n')
    } catch (error) {}
  }

  on (eventName, listener) {
    this.eventEmitter.on(eventName, listener)
  }

  close () {
    this.socket.end()
  }
}

class SyncSocket extends Socket {

  _create () {
    let socket = new Netlinkwrapper()
    return socket
  }

  connect (port, host) {
    super.connect(port, host)
    this.socket.blocking(true);
  }

  read () {
    while(true) {
      try {
        let chunk = this.socket.read(1024)
        this._processChunk(chunk)
        let message = this._processMessage()
        if (message) {
          return this.handler(message)
        }
      } catch (error) {
        
      }
    }
  }
  
  write (data) {
    try {
      this.socket.write(JSON.stringify(data) + '\n')
    } catch (error) {}
    return this.read()
  }

  close () {
    this.socket.disconnect()
  }
}

class Node {
  constructor (program) {
    process.env.BABEL_ENV = program.env
    process.env.BABEL_TARGET = program.target

    this.program = program
    this.sourceMaps = {}
    this.cacheDir = path.join(os.tmpdir(), 'babel', this.program.env, this.program.target)
    this.eslintCli = new eslint.CLIEngine({
      // fix: true 
    })
    this.compileTime = 0
  }

  moduleHandler ($module, filename, defaultHandler) {
    // this.display('>> ' + filename)
    if (filename.split(path.sep).indexOf('node_modules') !== -1) {
      return defaultHandler($module, filename)
    }
    let result = this.compile(filename)
    if (!result.code) {
      return defaultHandler($module, filename)
    }
    this.sourceMaps[filename] = result.map
    return $module._compile(result.code, filename)
  }
  
  replaceExtensionHooks (extensions) {
    let fallbackDefaultHandler = require.extensions['.js']
    for (let extension of extensions) {
      let defaultHandler = require.extensions[extension] || fallbackDefaultHandler;
      require.extensions[extension] = ($module, filename) => {
        this.moduleHandler($module, filename, defaultHandler)
      }
    }
  }

  display (message) {
    console.log(chalk.yellow(`[Babel] ${message}`))
  }
  
  displayDebug (message) {
    if (this.program.debug) {
      console.log(chalk.yellow(`[Babel-${this.constructor.name}] ${message}`))
    }
  }

  displayError(message) {
    let prefix = `[Babel] ${chalk.bgRedBright.black(' ERROR ')}`
    message = message.replace(/\n/g, `\n${new Array(17).fill(' ').join('')}`)
    console.error(chalk.redBright(`${prefix}  ${message}`))
  }

  installSourceMap () {
    sourceMapSupport.install({
      environment: 'node',
      // handleUncaughtExceptions: !!options.handleUncaughtExceptions,
      retrieveSourceMap: (filename) => {
        let map = this.sourceMaps && this.sourceMaps[filename]
        if (!map) {
          return
        }
        return { url: filename, map: map }
      }
    })
  }

  hashBabelOptions (babelOptions) {
    babelOptions = _.cloneDeep(babelOptions)
    for (let plugin of babelOptions.plugins) {
      delete plugin.visitor
    }
    return this.hash(babelOptions)
  }

  hash (data) {
    if (_.isObject(data)) {
      data = JSON.stringify(data)
    }
    return crypto.createHash('md5').update(data).digest('hex')
  }

  getCachePath (filename) {
    let cacheFilename = this.hash(filename) + '.json'
    return path.join(this.cacheDir, cacheFilename)
  }
  
  writeCache (filename, data) {
    let cachePath = this.getCachePath(filename)
    data = JSON.stringify(data)
    return fs.writeFileSync(cachePath, data)
  }
  
  readCache (filename) {
    let cachePath = this.getCachePath(filename)
    let data = null
    try {
      data = fs.readFileSync(cachePath).toString()
      data = JSON.parse(data)
    } catch (error) {
    }
    return data
  }

  compile (filename) {
    let startAt = process.hrtime()
    let result = this.readCache(filename) || {}
    let content = fs.readFileSync(filename).toString()
    let babelOptions = babel.loadOptions({ filename: filename })
    let contentHash = this.hash(content)
    let optionHash =  this.hashBabelOptions(babelOptions)
    let relativePath = `./${path.relative(cwd, filename)}`
    if (
      !this.program.cache 
      || result.contentHash !== contentHash
      || result.optionHash !== optionHash
    ) {
      result = {}
      result.filename = filename
      result.contentHash = contentHash
      result.optionHash = optionHash
      result.messages = []

      // Eslint
      if (path.parse(filename).name !== '.eslintrc') {
        let eslintResult = this.eslintCli.executeOnText(content, filename)
        result.messages = eslintResult.results[0] && eslintResult.results[0].messages || []
      }

      // Babel
      let babelResult = babel.transformSync(content, babelOptions)
      result.code = babelResult.code
      result.map = babelResult.map
      this.writeCache(filename, result)
    }
    let time = process.hrtime(startAt)
    time = time[0] + time[1] / NS_PER_SEC
    this.compileTime += time
    this.displayDebug(`Compiled (${time.toFixed(4)}s, ${this.compileTime.toFixed(4)}s): ${relativePath}`)

    // Showing Eslint Errors
    if ( result.messages.length > 0 ) {
      this.displayError(`Eslint Failed: ${relativePath}`)
      for (let message of result.messages) {
        this.displayError(`    ${message.line}:${message.column}: ${message.message}`)
      }
    }

    return result
  }
  
  init() {
    this.display(`Environment: ${program.env}`)
    this.display(`Target: ${program.target}`)
    this.displayDebug(`Cache Directory: ${this.cacheDir}`)
    let isCacheDirExist = shell.test('-d', this.cacheDir)
    if (!isCacheDirExist) {
      shell.mkdir('-p', this.cacheDir)
    }
  }

  getProgramArgs () {
    let args = []
    for (let rawArg of program.rawArgs.slice(1)) {
      if (program.args.indexOf(rawArg) === -1) {
        args.push(rawArg)
      }
    }
    return args
  }

  runNode (args) {
    process.argv = ['node', ...args]//.concat(options.args);
    process.execArgv = this.getProgramArgs().concat(process.execArgv)
    _module.runMain()
  }

  registerSignalHandler (eventNames, callback) {
    for (let eventName of eventNames) {
      process.on(eventName, () => {
        this.displayDebug(`Received ${eventName} signal.`)
        if (_.isFunction(callback)) {
          callback(eventName)
        }
      })
    }
  }

  async start () {
    this.init()
    this.replaceExtensionHooks(babel.DEFAULT_EXTENSIONS)
    this.runNode(this.program.args)
  }
}

class Server extends Node {
  constructor (program) {
    super(program)
    this.port = null
    this.server = null
    this.eventEmitter = new EventEmitter()
    this.child = null
    this.watcher = null
    this.prendingRestart = false
    this.restartListener = null
    this.cache = {}
    this.closed = false
  }

  sendMessage (socket, data) {
    try {
      // this.display('Server Send:', data.action)
      socket.write(JSON.stringify(data) + '\n')
    } catch (error) {
    }
  }

  async handleMessage (socket, message) {
    if (!message) return
    // this.display('Server Received: ', data);
    switch (message.action) {
      case 'ready':
        if (!this.child.socket) {
          this.child.socket = socket
        }
        this.sendMessage(socket, {
          action: 'start',
          args: this.program.args,
          extensions: babel.DEFAULT_EXTENSIONS
        })
        break
      case 'compile':
        try {
          let result = this.compile(message.filename)
          this.sendMessage(socket, {
            action: 'compiled',
            filename: message.filename,
            result: {
              code: result.code,
              map: result.map
            }
          })
        } catch (error) {
          this.displayError('Compile Error. Waiting for file change for restart ...')
          this.displayError(util.inspect(error))
          this.sendMessage(socket, {action: 'kill'})
        }
        break
      case 'watch':
        if (this.program.watch) {
          let relativeFilename = path.relative(cwd, message.filename);
          if (!this.watcher) {
            throw new Error('Internal Error: Watcher isn\'t created.')
          }
          this.watcher.add(relativeFilename);
          // this.sendMessage(socket, { action: 'watched' })
        }
        break
    }
  }
    
  fileChangedHandler (filePath, eventName) {
    let fileAbsolutePath = path.resolve(filePath)
    this.display(`File ${filePath} has been ${eventName}`)
    delete this.cache[fileAbsolutePath]
    if (this.restartListener) {
      clearTimeout(this.restartListener)
    }
    this.restartListener = setTimeout(() => {
      this.eventEmitter.emit('fileChanged')
      this.restartListener = null
    }, 1000)
  }

  initWatcher() {
    if (this.watcher) {
      this.watcher.close()
    }
    this.watcher = chokidar.watch([],{
      persistent: true
    })

    this.watcher
      .on('add', file => {
        // display(`File ${file} has been added`)
      })
      .on('change', file => {
        this.fileChangedHandler(file, 'changed')
      })
      .on('unlink', file => {
        this.fileChangedHandler(file, 'unlinked')
      })
  }

  compile (filename) {
    let result = this.cache[filename]
    if (!result) {
      result = super.compile(filename)
      this.cache[filename] = result
    }
    return result
  }
  
  createChild () {
    // display('Master started')
    if (this.program.watch) {
      this.initWatcher()
    }
    this.compileTime = 0
    this.prendingRestart = false
    this.child = cp.spawn(process.argv[0], this.getProgramArgs().concat([
      '-p', this.port
    ]), { stdio: 'inherit' })
    // display('Master spawnSync')
    this.child.on('close', () => {
      this.child = null
      if (this.prendingRestart) {
        this.display('Child is gone. restart now.')
        this.createChild()
      } else {
        this.display('Clean exit. Waiting for file change for restart ...')
      }
    })
  }

  close () {
    if (!this.closed) {
      this.closed = true
      this.displayDebug('Close process started')
      if (this.child) {
        this.displayDebug('Got Child.')
        this.child.removeAllListeners('close')
        this.child.on('close', () => {
          this.displayDebug('Child Closed. Exit now.')
          this.server.close()
          if (this.watcher) {
            this.watcher.close()
          }
        })
      } else {
        this.displayDebug('No Child.')
        this.server.close()
        if (this.watcher) {
          this.watcher.close()
        }
      }
    }
  }

  async start () {
    await this.init()

    this.registerSignalHandler([
      'SIGINT',
      'SIGQUIT',
      'SIGTERM',
      'SIGUSR1',
      'SIGUSR2'
    ], () => {
      this.close()
    })

    this.server = net.createServer((socket) => {
      let data = ''
      socket.on('data', (chunk) => {
        data += chunk
        let pos
        while ((pos = data.indexOf('\n')) !== -1) {
          let message = data.substr(0, pos)
          // display('Received', message)
          message = JSON.parse(message)
          this.handleMessage(socket, message)
          data = data.substr(pos + 1)
        }
      })
      socket.on('close', () => {
        // display('client is disconnect.')
      })
    })

    portfinder.basePort = 50000
    this.port = await portfinder.getPortPromise()
    this.server.listen(this.port, () => {
      this.display(`Babel Server is listening on Port ${this.port}`)
      this.createChild()
    })
    
    if (this.program.watch) {
      this.eventEmitter.on('fileChanged', () => {
        this.display('Files changed. Pending Restart ...')
        this.prendingRestart = true
        if (this.child) {
          if (this.child.socket) {
            this.sendMessage(this.child.socket, {action: 'kill'})
          }
        } else {
          this.createChild()
        }
      })
    }
  }
}

class Client extends Node {
  constructor (program) {
    super(program)
    this.port = Number.parseInt(program.port)
    this.socket = new Socket(this.messageHandler.bind(this))
    this.syncSocket = new SyncSocket(this.messageHandler.bind(this))
    this.closed = false
  }

  compile (filename) {
    return this.syncSocket.write({
      action: 'compile',
      filename: filename
    })
  }

  messageHandler (message) {
    if (!message) return
    // this.display('Client Received: ', data.action);
    switch (message.action) {
      case 'start':
        this.replaceExtensionHooks(message.extensions)
        this.runNode(message.args)
        this.socket.write({action: 'started'})
        break
      case 'compiled':
        // this.display('compiled', message.filename)
        return message.result
      case 'kill':
        if (this.program.force) {
          this.displayDebug('Exit immediately.')
          this.close().then(() => {
            process.exit()
          })
        } else {
          process.kill(process.pid, 'SIGINT');
        }
        break
      default:
        // this.display('Worker received', data)
        break
    }
  }
  
  replaceExtensionHooks (extensions) {
    super.replaceExtensionHooks(extensions)
    // Add Watcher
    for (let extension in require.extensions) {
      let handler = require.extensions[extension]
      require.extensions[extension] = ($module, filename) => {
        this.socket.write({
          action: 'watch',
          filename: filename
        })
        handler($module, filename)
      }
    }
  }

  async close () {
    if (!this.closed) {
      this.closed = true
      this.displayDebug('Close process started.')
      this.syncSocket.close()
      this.socket.close()
    }
  }

  async start (port) {
    this.registerSignalHandler([
      'SIGINT',
      'SIGQUIT',
      'SIGTERM',
      'SIGUSR1',
      'SIGUSR2'
    ], () => {
      this.close()
    })

    this.socket.connect(this.port, 'localhost')
    this.syncSocket.connect(this.port, 'localhost')
    
    // this.display(`Worker is initialized. Port: ${port}`)
    this.socket.write({action: 'ready'})
    this.installSourceMap()
  }
}

var program = new commander.Command('babel-node')
program
  .version('1.0')
  .usage('[options] <script.js> -- [arguments]')
  .option('--env [env]', 'Script enviroment', 'development')
  .option('--target [target]', 'Target to browser or node', 'node')
  .option('--debug', 'Debug mode')
  .option('--watch', 'Watch on file changes for restarting the script, which server mode is necessary.')
  .option('--force', 'Force kill on restarting script')
  .option('--no-cache', 'Disable cache')
  .option('-p, --port [port]', 'Server port for internal usage', parseInt)

program.parse(process.argv)
if (program.watch && program.port) {
  let client = new Client(program)
  client.start()
} else if (program.args.length > 0) {
  if (program.watch) {
    let server = new Server(program)
    server.start()
  } else {
    let node = new Node(program)
    node.start()
  }
} else {
  program.help()
}