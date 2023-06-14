export type Message = {
	role: 'assistant' | 'user' | 'system'
	content: string
}

const OPENAI_API_HOST = 'https://chat.postneko.workers.dev'
// api.openai.com
// chat.postneko.workers.dev

export const OpenAIStream = async (messages: Message[], callback: (content: string) => void) => {
	const url = `${OPENAI_API_HOST}/v1/chat/completions`
	const decoder = new TextDecoder()
	const x = {
		headers: { 'Content-Type': 'application/json' },
		method: 'POST',
		body: JSON.stringify({
			model: 'gpt-3.5-turbo-0301',
			messages: [
				{
					role: 'system',
					content: '',
				},
				...messages,
			],
			stream: true,
		}),
	}

	fetch(url, x)
		.then((response) => {
			const reader = response.body?.getReader()
			reader?.read().then(function pump({ done, value }): any {
				if (done) {
					return
				}
				const data = decoder.decode(value)
				const lines = data.split('\n')
				lines.forEach((line) => {
					if (line.startsWith('data:') && !line.endsWith('[DONE]')) {
						const data = line.slice(5).trim()
						try {
							const json = JSON.parse(data)
							const content = json.choices[0]?.delta?.content ?? ''
							callback(content)
						} catch (e) {
							// ignore json parse error
						}
					}
				})
				return reader.read().then(pump)
			})
		})
		.catch((err) => console.error(err))
}
