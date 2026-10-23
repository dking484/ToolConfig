import { createApp } from 'vue'
import App from './App.vue'
import './style.css'
import { connect } from './store'

connect()
createApp(App).mount('#app')
